import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { exec } from "@oh-my-pi/pi-utils/ptree";
import { z } from "zod";
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

import { createInstallerLock, replaceLink } from "./shared";

const manifestSchema = z.strictObject({
  protocolMajor: z.literal(PROTOCOL_MAJOR),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  platform: z.literal("darwin"),
});
const identitySchema = z.strictObject({ installationId: z.uuid() });

const generationSchema = z.strictObject({
  manager: z.literal("brew"),
  packagePath: z.string().startsWith("/"),
  version: z.string(),
  packageIdentity: z.strictObject({ version: z.string(), architecture: z.string() }),
});
const recordSchema = z.strictObject({
  version: z.literal(1),
  current: generationSchema,
  previous: generationSchema.optional(),
});
const preparationSchema = z.strictObject({
  version: z.literal(1),
  maintenanceToken: z.uuid(),
  original: generationSchema,
});
type Generation = z.infer<typeof generationSchema>;
type Preparation = z.infer<typeof preparationSchema>;

function locations() {
  const p = paths();
  return {
    ...p,
    record: join(p.state, "installer.json"),
    current: join(p.data, "current"),
    previous: join(p.data, "previous"),
    lock: join(p.state, "maintenance.lock"),
    preparation: join(p.state, "maintenance.lock/preparation.json"),
  };
}

async function installed() {
  try {
    return recordSchema.parse(JSON.parse(await privateRead(locations().record)));
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return undefined;
  }
}

async function brew(args: string[]): Promise<string> {
  const executable =
    Bun.which("brew") ??
    (process.arch === "arm64" ? "/opt/homebrew/bin/brew" : "/usr/local/bin/brew");
  const {
    exitCode: code,
    stdout,
    stderr,
  } = await exec([executable, ...args], {
    allowNonZero: true,
    stderr: "full",
    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" },
  });
  if (code !== 0)
    throw new Error(`Homebrew ${args[0]} failed (${code}): ${stderr.trim()}`);
  return stdout.trim();
}

async function artifact(packagePath: string): Promise<Generation> {
  const cellar = await realpath(await brew(["--cellar", "omp-helper"]));
  const keg = dirname(packagePath);
  if (
    dirname(keg) !== cellar ||
    packagePath !== join(keg, "libexec") ||
    (await realpath(packagePath)) !== packagePath
  )
    throw new Error(
      "packagePath must identify a canonical omp-helper Homebrew keg's libexec payload",
    );
  const manifest = manifestSchema.parse(
    JSON.parse(
      await readFile(join(packagePath, "share/omp-helper/manifest.json"), "utf8"),
    ),
  );
  const build = z
    .object({
      architecture: z.literal(process.arch),
      release: z.string().regex(/^[1-9][0-9]*$/u),
    })
    .parse(
      JSON.parse(
        await readFile(join(packagePath, "share/omp-helper/build.json"), "utf8"),
      ),
    );
  const identity = `${manifest.version}_${build.release}`;
  if (keg !== join(cellar, identity))
    throw new Error("Homebrew keg version/revision disagrees with the payload");
  if (!(await lstat(join(keg, "INSTALL_RECEIPT.json"))).isFile())
    throw new Error("Payload lacks a Homebrew installation receipt");
  async function inspect(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
      throw new Error(`Unsafe Homebrew payload ownership or permissions: ${directory}`);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const stat = await lstat(file);
      if (
        stat.uid !== process.getuid?.() ||
        (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)
      )
        throw new Error(`Unsafe Homebrew payload: ${file}`);
      if (stat.isSymbolicLink()) {
        if (!(await realpath(file)).startsWith(`${packagePath}/`))
          throw new Error(`Homebrew payload symlink escapes its package: ${file}`);
      } else if (stat.isDirectory()) await inspect(file);
      else if (!stat.isFile())
        throw new Error(`Homebrew payload contains a special file: ${file}`);
    }
  }
  await inspect(packagePath);
  for (const name of ["omp-helper", "bun"]) {
    const info = await lstat(join(packagePath, "bin", name));
    if (!info.isFile() || (info.mode & 0o111) === 0)
      throw new Error(`Payload lacks executable ${name}`);
  }
  return {
    manager: "brew",
    packagePath,
    version: manifest.version,
    packageIdentity: { version: identity, architecture: build.architecture },
  };
}

async function ownership(generation: Generation) {
  try {
    if (
      JSON.stringify(await artifact(generation.packagePath)) !==
      JSON.stringify(generation)
    )
      throw new Error("Recorded Homebrew generation no longer matches its package");
    return { manager: "brew", owned: true };
  } catch (error) {
    return {
      manager: "brew",
      owned: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function assertOwned(
  record: z.infer<typeof recordSchema> | undefined,
): Promise<void> {
  const p = locations();
  for (const [path, generation] of [
    [p.current, record?.current],
    [p.previous, record?.previous],
  ] as const) {
    if (await exists(path)) {
      const info = await lstat(path);
      if (
        !generation ||
        !info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (await readlink(path)) !== generation.packagePath
      )
        throw new Error(`Refusing unrelated installation link: ${path}`);
    } else if (generation)
      throw new Error(`Owned installation link is missing: ${path}`);
  }
}

async function prepared(): Promise<Preparation | undefined> {
  const p = locations();
  if (!(await exists(p.preparation))) return undefined;
  await privateDirectory(p.lock);
  return preparationSchema.parse(JSON.parse(await privateRead(p.preparation)));
}

const installerLock = createInstallerLock(prepared);

async function assertIdle(): Promise<void> {
  if (await inspectBusyJobs())
    throw new Error("Helper has running jobs; stop them before package maintenance");
}

export async function status() {
  const record = await installed();
  const pending = await prepared();
  const maintenance = await exists(locations().lock);
  if (!record)
    return {
      installed: false,
      jobsReady: false,
      status: maintenance ? "maintenance" : "not-installed",
      platform: "darwin",
      ...(pending ? { maintenanceToken: pending.maintenanceToken } : {}),
    };
  await assertOwned(record);
  const identity = identitySchema.parse(
    JSON.parse(await privateRead(join(paths().state, "installation.json"))),
  );
  const packageOwnership = await ownership(record.current);
  if (packageOwnership.owned && !maintenance) await verifyBrokerRuntime();
  return {
    installed: true,
    jobsReady: packageOwnership.owned && !maintenance,
    protocolMajor: PROTOCOL_MAJOR,
    platform: "darwin",
    ...identity,
    version: record.current.version,
    packagePath: record.current.packagePath,
    manager: "brew",
    packageOwnership,
    previous: record.previous
      ? { ...record.previous, packageOwnership: await ownership(record.previous) }
      : null,
    status: maintenance
      ? "maintenance"
      : packageOwnership.owned
        ? "ready"
        : "package-unavailable",
    desktop: null,
    desktopUnavailable: "Linux desktop access is unavailable on macOS; use Skylight",
    ...(pending ? { maintenanceToken: pending.maintenanceToken } : {}),
  };
}

export async function prepareUpgrade() {
  const p = locations();
  await privateDirectory(p.state);
  await mkdir(p.lock, { mode: 0o700 });
  let pending: Preparation | undefined;
  try {
    await mkdir(join(p.lock, "operation"), { mode: 0o700 });
    await atomicWrite(
      join(p.lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const record = await installed();
    if (!record) throw new Error("Helper is not installed; use install");
    await assertOwned(record);
    const checked = await ownership(record.current);
    if (!checked.owned) throw new Error(checked.error);
    await assertIdle();
    const preparation: Preparation = {
      version: 1,
      maintenanceToken: randomUUID(),
      original: record.current,
    };
    await atomicWrite(p.preparation, `${JSON.stringify(preparation)}\n`);
    pending = preparation;
    await rm(join(p.lock, "operation"), { recursive: true });
    return {
      status: "prepared",
      maintenanceToken: preparation.maintenanceToken,
      packagePath: record.current.packagePath,
      manager: "brew",
      packageIdentity: record.current.packageIdentity,
    };
  } catch (error) {
    if (pending) {
      await rm(join(p.lock, "operation"), { recursive: true, force: true });
      throw new Error(
        `Preparation failed; maintenance remains held, recover with token ${pending.maintenanceToken}`,
        { cause: error },
      );
    }
    await rm(p.lock, { recursive: true });
    throw error;
  }
}

export async function cancelUpgrade(token: string) {
  await installerLock(token, async (pending) => {
    const record = await installed();
    if (!record || JSON.stringify(record.current) !== JSON.stringify(pending?.original))
      throw new Error("Original activation no longer matches the pending upgrade");
    await assertOwned(record);
    const checked = await ownership(record.current);
    if (!checked.owned)
      throw new Error(
        `Restore the original Homebrew keg before cancellation: ${checked.error}`,
      );
    await verifyBrokerRuntime();
  });
  return status();
}

export async function install(
  action: "install" | "upgrade",
  packagePath: string,
  waylandDisplay?: string,
  token?: string,
) {
  if (waylandDisplay)
    throw new Error("Wayland desktop activation is unavailable on macOS");
  await loadIdentity();
  await installerLock(token, async (pending) => {
    const p = locations();
    await privateDirectory(p.data);
    const old = await installed();
    if (action === "install" && old)
      throw new Error("Helper is already installed; use upgrade");
    if (action === "upgrade" && !old)
      throw new Error("Helper is not installed; use install");
    if (pending && JSON.stringify(old?.current) !== JSON.stringify(pending.original))
      throw new Error("Original activation no longer matches the pending upgrade");
    await assertOwned(old);
    await assertIdle();
    const current = await artifact(packagePath);
    await verifyBrokerRuntime();
    const previous =
      old && old.current.packagePath !== current.packagePath
        ? old.current
        : old?.previous;
    try {
      await replaceLink(p.current, current.packagePath);
      if (previous) await replaceLink(p.previous, previous.packagePath);
      else await rm(p.previous, { force: true });
      await atomicWrite(
        p.record,
        `${JSON.stringify({ version: 1, current, ...(previous ? { previous } : {}) })}\n`,
      );
    } catch (error) {
      if (old) await replaceLink(p.current, old.current.packagePath);
      else await rm(p.current, { force: true });
      if (old?.previous) await replaceLink(p.previous, old.previous.packagePath);
      else await rm(p.previous, { force: true });
      throw error;
    }
  });
  return status();
}

export async function uninstall(token?: string) {
  return installerLock(token, async () => {
    const record = await installed();
    if (!record) return { installed: false, status: "not-installed" };
    await assertOwned(record);
    await assertIdle();
    const p = locations();
    for (const path of [p.current, p.previous, p.record])
      await rm(path, { force: true });
    return { installed: false, status: "uninstalled", historyRetained: true };
  });
}
