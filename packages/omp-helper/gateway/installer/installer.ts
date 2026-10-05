import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { z } from "zod";
import { desktopHealth } from "../desktop";
import { inspectBusyJobs, verifyBrokerRuntime } from "../jobs/jobs";
import {
  atomicWrite,
  exists,
  loadIdentity,
  PROTOCOL_MAJOR,
  paths,
  privateDirectory,
  privateRead,
} from "../state";
import {
  activateDesktop,
  backupFiles,
  desktopEnvironment,
  healthyDesktop,
  packageGeneration,
  rollbackActivation,
  stageDesktopFiles,
} from "./activation";
import { command } from "./command";
import { locations, UNIT } from "./locations";
import { assertOwned } from "./ownership";
import { artifact, packageOwnership } from "./packages";
import {
  type InstallationRecord,
  type Preparation,
  preparationSchema,
  recordSchema,
} from "./schemas";
import { createInstallerLock } from "./shared";
import {
  GNOME_SHELL_VERSION,
  workspaceExtensionEnabled,
  workspaceIsolation,
} from "./workspace";

const identitySchema = z.strictObject({ installationId: z.uuid() });
const workspaceBusySchema = z.object({
  data: z.tuple([z.number().int().nonnegative()]),
});
async function installed(): Promise<InstallationRecord | undefined> {
  try {
    return recordSchema.parse(JSON.parse(await privateRead(locations().record)));
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

async function assertIdle(installationId: string): Promise<void> {
  const workspaces = await command(
    [
      "busctl",
      "--user",
      "--json=short",
      "call",
      "org.gnome.Shell",
      "/io/github/fourevy/OmpWorkspaces",
      "io.github.fourevy.OmpWorkspaces1",
      "Busy",
    ],
    true,
  );
  if (workspaces.code === 0) {
    const busy = workspaceBusySchema.parse(JSON.parse(workspaces.stdout));
    if (busy.data[0] !== 0)
      throw new Error(
        "Helper has live GUI workspace leases; release them before upgrade or uninstall",
      );
  }
  if (await inspectBusyJobs())
    throw new Error(
      "Helper has live managed jobs; stop them explicitly before upgrade or uninstall",
    );
  const active =
    (await command(["systemctl", "--user", "is-active", UNIT], true)).code === 0;
  if (active || (await exists(join(paths().runtime, "desktop.sock")))) {
    const health = await desktopHealth(installationId);
    if (health.controlLeaseActive)
      throw new Error(
        "Desktop control is leased; release it explicitly before upgrade or uninstall",
      );
  }
}

async function prepared(): Promise<Preparation | undefined> {
  if (!(await exists(locations().preparation))) return undefined;
  const info = await lstat(locations().lock);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("Maintenance lock has unsafe ownership, type or permissions");
  }
  return preparationSchema.parse(
    JSON.parse(await privateRead(locations().preparation)),
  );
}

const installerLock = createInstallerLock(prepared);

// This gate survives the package transaction and the process that prepared it
// Failed activation keeps it closed until explicit retry, cancellation or removal
export async function prepareUpgrade() {
  const p = locations();
  await privateDirectory(p.state);
  await mkdir(p.lock, { mode: 0o700 });
  let preparation: Preparation | undefined;
  try {
    await mkdir(join(p.lock, "operation"), { mode: 0o700 });
    await atomicWrite(
      join(p.lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const record = await installed();
    if (!record) throw new Error("Helper is not installed; use install");
    await assertOwned(record);
    const ownership = await packageOwnership(record.current);
    if (!ownership.owned) throw new Error(ownership.error);
    const identity = await loadIdentity();
    await assertIdle(identity.installationId);
    const pending: Preparation = {
      version: 1,
      maintenanceToken: randomUUID(),
      original: record.current,
      wasActive:
        (await command(["systemctl", "--user", "is-active", UNIT], true)).code === 0,
      wasEnabled:
        (await command(["systemctl", "--user", "is-enabled", UNIT], true)).code === 0,
    };
    await atomicWrite(p.preparation, `${JSON.stringify(pending)}\n`);
    preparation = pending;
    await command(["systemctl", "--user", "disable", "--now", UNIT]);
    await rm(join(p.lock, "operation"), { recursive: true });
    return {
      status: "prepared",
      maintenanceToken: preparation.maintenanceToken,
      packagePath: record.current.packagePath,
      manager: record.current.manager,
      ...(record.current.manager !== "nix"
        ? { packageIdentity: record.current.packageIdentity }
        : {}),
    };
  } catch (error) {
    if (preparation) {
      await rm(join(p.lock, "operation"), { recursive: true, force: true });
      throw new Error(
        `Preparation failed: ${error instanceof Error ? error.message : String(error)}; maintenance remains held, recover with token ${preparation.maintenanceToken}`,
        { cause: error },
      );
    }
    await rm(p.lock, { recursive: true });
    throw error;
  }
}

export async function cancelUpgrade(maintenanceToken: string) {
  await installerLock(maintenanceToken, async (preparation) => {
    const record = await installed();
    if (
      !record ||
      !preparation ||
      record.current.packagePath !== preparation.original.packagePath ||
      record.current.manager !== preparation.original.manager ||
      record.current.version !== preparation.original.version ||
      (record.current.manager !== "nix" &&
        preparation.original.manager !== "nix" &&
        (record.current.packageIdentity.version !==
          preparation.original.packageIdentity.version ||
          record.current.packageIdentity.architecture !==
            preparation.original.packageIdentity.architecture))
    )
      throw new Error("Original activation no longer matches the pending upgrade");
    await assertOwned(record);
    const ownership = await packageOwnership(record.current);
    if (!ownership.owned)
      throw new Error(
        `Cannot resume the original package: ${ownership.error}; reinstall it with its package manager or activate the replacement`,
      );
    try {
      if (preparation.wasEnabled)
        await command(["systemctl", "--user", "enable", UNIT]);
      if (preparation.wasActive) {
        await command(["systemctl", "--user", "start", UNIT]);
        const identity = await loadIdentity();
        await healthyDesktop(identity.installationId, record.current.version);
      }
    } catch (error) {
      await command(["systemctl", "--user", "disable", "--now", UNIT]);
      throw error;
    }
  });
  return status();
}

export async function status() {
  const record = await installed();
  const preparation = await prepared();
  if (!record)
    return {
      installed: false,
      jobsReady: false,
      status: preparation ? "maintenance" : "not-installed",
      ...(preparation ? { maintenanceToken: preparation.maintenanceToken } : {}),
    };
  await assertOwned(record);
  const identity = identitySchema.parse(
    JSON.parse(await privateRead(join(paths().state, "installation.json"))),
  );
  const ownership = await packageOwnership(record.current);
  const maintenance = await exists(locations().lock);
  if (ownership.owned && !maintenance) await verifyBrokerRuntime();
  const active =
    (await command(["systemctl", "--user", "is-active", UNIT], true)).code === 0;
  return {
    installed: true,
    jobsReady: ownership.owned && !maintenance,
    protocolMajor: PROTOCOL_MAJOR,
    version: record.current.version,
    ...identity,
    packagePath: record.current.packagePath,
    manager: record.current.manager,
    packageOwnership: ownership,
    workspaceIsolation: await workspaceIsolation(),
    previous: record.previous
      ? {
          ...record.previous,
          packageOwnership: await packageOwnership(record.previous),
        }
      : null,
    ...(preparation ? { maintenanceToken: preparation.maintenanceToken } : {}),
    status: maintenance
      ? "maintenance"
      : !ownership.owned
        ? "package-unavailable"
        : active
          ? "ready"
          : "jobs-ready-desktop-awaiting-session",
    desktop:
      active && ownership.owned && !maintenance
        ? await desktopHealth(identity.installationId, record.current.version)
        : null,
  };
}

async function prepareInstallation(
  action: "install" | "upgrade",
  packagePath: string,
  waylandDisplay: string | undefined,
  preparation: Preparation | undefined,
  installationId: string,
) {
  const manifest = await artifact(packagePath);
  const old = await installed();
  if (action === "upgrade" && !old)
    throw new Error("Helper is not installed; use install");
  await assertOwned(old);
  const savedDisplay =
    old && waylandDisplay === undefined
      ? (await readFile(locations().environment, "utf8")).match(
          /^WAYLAND_DISPLAY=([A-Za-z0-9_.-]+)\n$/u,
        )?.[1]
      : undefined;
  const environment = await desktopEnvironment(waylandDisplay ?? savedDisplay);
  if (
    preparation &&
    old?.current.packagePath !== preparation.original.packagePath &&
    old?.current.packagePath !== packagePath
  )
    throw new Error("Pending upgrade does not match the installed generation");
  const oldOwnership = old ? await packageOwnership(old.current) : undefined;
  if (old && !oldOwnership?.owned && !preparation)
    throw new Error(
      "Current package is unavailable; an upgrade must be prepared before its package manager removes the payload",
    );
  if (old?.current.packagePath === packagePath && !preparation) {
    if (action === "upgrade") await assertIdle(installationId);
    if (
      waylandDisplay !== undefined &&
      (await readFile(locations().environment, "utf8")) !== environment.environment
    ) {
      throw new Error(
        "Installed artifact already exists with a different display; release work and uninstall before rebinding it",
      );
    }
    await verifyBrokerRuntime();
    return;
  }
  return { manifest, old, environment, oldOwnership };
}

export async function install(
  action: "install" | "upgrade",
  packagePath: string,
  waylandDisplay?: string,
  maintenanceToken?: string,
) {
  if (process.platform !== "linux")
    throw new Error("omp-helper installation requires Linux");
  const identity = await loadIdentity();
  let workspaceActivationError: string | undefined;
  await installerLock(maintenanceToken, async (preparation) => {
    const prepared = await prepareInstallation(
      action,
      packagePath,
      waylandDisplay,
      preparation,
      identity.installationId,
    );
    if (!prepared) return;
    const { manifest, old, environment, oldOwnership } = prepared;
    await assertIdle(identity.installationId);
    const p = locations();
    await privateDirectory(p.data);
    if (manifest.manager === "nix") await privateDirectory(p.roots);
    await mkdir(dirname(p.unit), { recursive: true });
    await mkdir(dirname(p.descriptor), { recursive: true });
    await mkdir(p.workspaceExtension, { recursive: true });
    const generation = packageGeneration(manifest, packagePath, p.roots);
    const previous =
      oldOwnership?.owned && old?.current.packagePath !== packagePath
        ? old?.current
        : undefined;
    const staged = await stageDesktopFiles(packagePath, environment.environment, p);
    const backups = await backupFiles(staged.keys());
    const wasActive =
      (await command(["systemctl", "--user", "is-active", UNIT], true)).code === 0;
    const wasEnabled =
      (await command(["systemctl", "--user", "is-enabled", UNIT], true)).code === 0;
    if (generation.manager === "nix")
      await command([
        "nix-store",
        "--add-root",
        generation.root,
        "--indirect",
        "--realise",
        packagePath,
      ]);
    try {
      workspaceActivationError = await activateDesktop({
        p,
        staged,
        generation,
        previous,
        preparation,
        wasActive,
        graphical: environment.graphical,
        installationId: identity.installationId,
      });
    } catch (error) {
      try {
        await rollbackActivation({
          p,
          backups,
          old,
          oldOwned: oldOwnership?.owned ?? false,
          preparation,
          wasActive,
          wasEnabled,
          generation,
          installationId: identity.installationId,
        });
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          "Activation and per-user rollback failed; package-manager state was not rolled back and recovery data was retained",
        );
      }
      throw error;
    }
    if (
      old?.previous?.manager === "nix" &&
      old.previous.root !== (previous?.manager === "nix" ? previous.root : undefined)
    ) {
      await rm(old.previous.root, { force: true });
    }
    if (old?.current.manager === "nix" && previous !== old.current)
      await rm(old.current.root, { force: true });
  });
  const result = await status();
  return workspaceActivationError
    ? {
        ...result,
        workspaceIsolation: {
          status: "prerequisite",
          reason: workspaceActivationError,
        },
      }
    : result;
}

export async function uninstall(maintenanceToken?: string) {
  return installerLock(maintenanceToken, async () => {
    const record = await installed();
    if (!record) return { installed: false, status: "not-installed" };
    await assertOwned(record);
    const identity = await loadIdentity();
    await assertIdle(identity.installationId);
    const p = locations();
    const tokens = join(p.state, "tokens");
    if (await exists(tokens)) {
      const info = await lstat(tokens);
      if (
        !info.isDirectory() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0
      ) {
        throw new Error("Refusing unsafe restore-token directory");
      }
    }
    await command(["systemctl", "--user", "disable", "--now", UNIT]);
    if (record.files.some((file) => file.path.startsWith(`${p.workspaceExtension}/`))) {
      const shell = await command(GNOME_SHELL_VERSION, true);
      if (shell.code === 0) await workspaceExtensionEnabled(false);
    }
    await rm(tokens, { recursive: true, force: true });
    for (const file of record.files) await rm(file.path);
    for (const path of [
      p.current,
      p.previous,
      record.current.manager === "nix" ? record.current.root : undefined,
      record.previous?.manager === "nix" ? record.previous.root : undefined,
      p.record,
    ]) {
      if (path) await rm(path, { force: true });
    }
    await command(["systemctl", "--user", "daemon-reload"]);
    return { installed: false, status: "uninstalled", historyRetained: true };
  });
}
