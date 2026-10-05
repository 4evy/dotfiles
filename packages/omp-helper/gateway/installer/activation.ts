import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { desktopHealth } from "../desktop";
import { verifyBrokerRuntime } from "../jobs/jobs";
import { atomicWrite, exists, paths } from "../state";
import { command } from "./command";
import { type Locations, UNIT, WORKSPACE_EXTENSION_FILES } from "./locations";
import type { artifact } from "./packages";
import type { Generation, InstallationRecord, Preparation } from "./schemas";
import { replaceLink } from "./shared";
import { GNOME_SHELL_VERSION, workspaceExtensionEnabled } from "./workspace";
export async function desktopEnvironment(waylandDisplay?: string) {
  await command(["systemctl", "--user", "show-environment"]);
  const graphical =
    (
      await command(
        ["systemctl", "--user", "is-active", "graphical-session.target"],
        true,
      )
    ).code === 0;
  const manager = (await command(["systemctl", "--user", "show-environment"])).stdout;
  const values = new Map(
    manager
      .trim()
      .split("\n")
      .map((line) => {
        const equal = line.indexOf("=");
        return [line.slice(0, equal), line.slice(equal + 1)];
      }),
  );
  const display = waylandDisplay ?? values.get("WAYLAND_DISPLAY");
  if (graphical || waylandDisplay !== undefined) {
    if (
      !display ||
      !/^[A-Za-z0-9_.-]+$/u.test(display) ||
      display === "." ||
      display === ".."
    ) {
      throw new Error(
        "Desktop prerequisite: a valid user-manager WAYLAND_DISPLAY or explicit waylandDisplay is required",
      );
    }
    const runtime = dirname(paths().runtime);
    const socket = await lstat(join(runtime, display));
    if (!socket.isSocket() || socket.uid !== process.getuid?.())
      throw new Error("Selected Wayland display is not an owned socket");
    if (
      values.get("XDG_RUNTIME_DIR") !== runtime ||
      !(await exists(join(runtime, "bus")))
    ) {
      throw new Error(
        "Desktop prerequisite: user-manager runtime directory and graphical D-Bus integration are missing",
      );
    }
  }
  return {
    graphical,
    environment:
      waylandDisplay === undefined ? "" : `WAYLAND_DISPLAY=${waylandDisplay}\n`,
  };
}

export async function healthyDesktop(
  installationId: string,
  version: string,
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await desktopHealth(installationId, version);
      return;
    } catch (error) {
      failure = error;
      await Bun.sleep(100);
    }
  }
  throw new Error(
    "Activated desktop service failed its protocol/identity health check",
    { cause: failure },
  );
}

export async function stageDesktopFiles(
  packagePath: string,
  environment: string,
  p: Locations,
): Promise<Map<string, string>> {
  const staged = new Map<string, string>();
  const templates = [
    { source: "omp-helper-desktop.service.in", destination: p.unit },
    { source: "io.github.fourevy.OmpHelper.desktop.in", destination: p.descriptor },
  ];
  const replacements = {
    "@PACKAGE@": packagePath,
    "@ENVIRONMENT_FILE@": p.environment.replaceAll("%", "%%"),
  };
  for (const { source, destination } of templates) {
    let content = await readFile(join(packagePath, "share/omp-helper", source), "utf8");
    for (const [placeholder, value] of Object.entries(replacements))
      content = content.replaceAll(placeholder, value);
    staged.set(destination, content);
  }
  staged.set(p.environment, environment);
  for (const name of WORKSPACE_EXTENSION_FILES) {
    const source = await readFile(
      join(packagePath, "share/omp-helper/gnome", name),
      "utf8",
    );
    staged.set(
      join(p.workspaceExtension, name),
      name === "extension.js"
        ? source.replace(
            "@SOURCE_HASH@",
            createHash("sha256").update(source).digest("hex"),
          )
        : source,
    );
  }
  return staged;
}

export async function backupFiles(
  files: Iterable<string>,
): Promise<Map<string, string | undefined>> {
  const backups = new Map<string, string | undefined>();
  for (const file of files)
    backups.set(file, (await exists(file)) ? await readFile(file, "utf8") : undefined);
  return backups;
}

async function restoreFiles(
  backups: ReadonlyMap<string, string | undefined>,
): Promise<void> {
  for (const [file, content] of backups) {
    if (content === undefined) await rm(file, { force: true });
    else await atomicWrite(file, content);
  }
}

async function generationLinks(
  p: Locations,
  current: Generation | undefined,
  previous: Generation | undefined,
): Promise<void> {
  for (const [path, generation] of [
    [p.current, current],
    [p.previous, previous],
  ] as const) {
    if (generation) await replaceLink(path, generation.packagePath);
    else await rm(path, { force: true });
  }
}

interface ActivationBackup {
  p: Locations;
  backups: ReadonlyMap<string, string | undefined>;
  old: InstallationRecord | undefined;
  oldOwned: boolean;
  preparation: Preparation | undefined;
  wasActive: boolean;
  wasEnabled: boolean;
  generation: Generation;
  installationId: string;
}

export async function rollbackActivation({
  p,
  backups,
  old,
  oldOwned,
  preparation,
  wasActive,
  wasEnabled,
  generation,
  installationId,
}: ActivationBackup): Promise<void> {
  await command(["systemctl", "--user", "stop", UNIT], true);
  if (preparation || !wasEnabled)
    await command(["systemctl", "--user", "disable", UNIT], true);
  await restoreFiles(backups);
  if (!old?.files.some((file) => file.path.startsWith(`${p.workspaceExtension}/`))) {
    await workspaceExtensionEnabled(false).catch(() => {});
  }
  await generationLinks(p, old?.current, old?.previous);
  await command(["systemctl", "--user", "daemon-reload"]);
  if (!preparation && old && oldOwned) {
    if (wasEnabled) await command(["systemctl", "--user", "enable", UNIT]);
    if (wasActive) {
      await command(["systemctl", "--user", "start", UNIT]);
      await healthyDesktop(installationId, old.current.version);
    }
  }
  if (generation.manager === "nix") await rm(generation.root, { force: true });
}

export function packageGeneration(
  manifest: Awaited<ReturnType<typeof artifact>>,
  packagePath: string,
  roots: string,
): Generation {
  return manifest.manager === "nix"
    ? {
        manager: "nix",
        packagePath,
        version: manifest.version,
        root: join(roots, randomUUID()),
      }
    : {
        manager: manifest.manager,
        packagePath,
        version: manifest.version,
        packageIdentity: manifest.packageIdentity,
      };
}

interface DesktopActivation {
  p: Locations;
  staged: ReadonlyMap<string, string>;
  generation: Generation;
  previous: Generation | undefined;
  preparation: Preparation | undefined;
  wasActive: boolean;
  graphical: boolean;
  installationId: string;
}

export async function activateDesktop({
  p,
  staged,
  generation,
  previous,
  preparation,
  wasActive,
  graphical,
  installationId,
}: DesktopActivation): Promise<string | undefined> {
  let workspaceActivationError: string | undefined;
  if (wasActive) await command(["systemctl", "--user", "stop", UNIT]);
  for (const [file, content] of staged) await atomicWrite(file, content);
  const shell = await command(GNOME_SHELL_VERSION, true);
  if (shell.code === 0) {
    try {
      await workspaceExtensionEnabled(true);
    } catch (error) {
      workspaceActivationError = `Workspace adapter activation failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  await generationLinks(p, generation, previous);
  await command(["systemctl", "--user", "daemon-reload"]);
  await command([
    "systemctl",
    "--user",
    preparation?.wasEnabled === false ? "disable" : "enable",
    UNIT,
  ]);
  await verifyBrokerRuntime();
  if (preparation ? preparation.wasActive : graphical) {
    await command(["systemctl", "--user", "start", UNIT]);
    await healthyDesktop(installationId, generation.version);
  }
  const record: InstallationRecord = {
    version: 2,
    current: generation,
    ...(previous ? { previous } : {}),
    files: [...staged].map(([path, content]) => ({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  };
  await atomicWrite(p.record, `${JSON.stringify(record)}\n`);
  return workspaceActivationError;
}
