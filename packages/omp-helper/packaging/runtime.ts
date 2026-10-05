import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { copy, run } from "./common";
import type { BuildContext } from "./targets";

async function stageRuntimeSource({
  runtime,
  source,
  work,
  darwin,
  repo,
}: BuildContext): Promise<void> {
  await mkdir(runtime, { recursive: true });
  const response = await fetch(source.url);
  if (!response.ok)
    throw new Error(`OMP source download failed: HTTP ${response.status}`);
  const archive = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== source.sha256)
    throw new Error("OMP source archive checksum mismatch");
  const archivePath = join(work, "omp.tar.gz");
  await writeFile(archivePath, archive);
  await run(
    [
      darwin ? "gtar" : "tar",
      "--extract",
      "--gzip",
      "--file",
      archivePath,
      "--strip-components=1",
      "--no-same-owner",
      "--directory",
      runtime,
    ],
    work,
  );
  const patches = (await readdir(join(repo, "packages/omp/patches")))
    .filter((name) => name.endsWith(".patch"))
    .sort();
  for (const patch of [
    ...patches.map((name) => join(repo, "packages/omp/patches", name)),
    join(repo, "packages/omp/broker-environment.patch"),
    ...(!darwin ? [join(repo, "packages/omp/immutable-update.patch")] : []),
  ]) {
    await run(
      ["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i", patch],
      runtime,
    );
  }
}

function runtimeInstallArgs(bunPath: string): string[] {
  return [
    bunPath,
    "install",
    "--frozen-lockfile",
    "--production",
    "--ignore-scripts",
    "--linker=hoisted",
    "--backend=copyfile",
  ];
}

async function installRuntimeClosure({
  runtime,
  repo,
  bunPath,
}: BuildContext): Promise<void> {
  const runtimeManifest = await readFile(join(runtime, "package.json"));
  await copyFile(
    join(repo, "packages/omp/upstream/package.json"),
    join(runtime, "package.json"),
  );
  await copyFile(
    join(repo, "packages/omp/upstream/bun.lock"),
    join(runtime, "bun.lock"),
  );
  await run(runtimeInstallArgs(bunPath), runtime);
  await writeFile(join(runtime, "package.json"), runtimeManifest);
  for (const directory of (await readdir(join(runtime, "packages"))).sort()) {
    const packagePath = join(runtime, "packages", directory);
    const file = Bun.file(join(packagePath, "package.json"));
    if (!(await file.exists())) continue;
    const { name } = await file.json();
    if (typeof name !== "string" || !name.startsWith("@oh-my-pi/")) continue;
    const installed = join(runtime, "node_modules", name);
    if (!(await Bun.file(join(installed, "package.json")).exists())) continue;
    await rm(installed, { recursive: true });
    await symlink(relative(dirname(installed), packagePath), installed);
  }
}

async function linkNativeRuntime(runtime: string, target: string): Promise<string> {
  // Published npm shims point at dist/cli.js, which source-mode replaces
  for (const directory of [runtime, target]) {
    const launcher = join(directory, "node_modules/.bin/omp");
    await rm(launcher, { force: true });
    await symlink(
      relative(dirname(launcher), join(runtime, "packages/coding-agent/src/cli.ts")),
      launcher,
    );
  }
  const nativePackage = join(
    runtime,
    `node_modules/@oh-my-pi/pi-natives-${process.platform}-${process.arch}`,
  );
  if (!(await Bun.file(join(nativePackage, "package.json")).exists()))
    throw new Error(
      `Locked native addon missing for ${process.platform}-${process.arch}`,
    );
  // Source-mode loading deliberately skips node_modules platform packages
  const nativeDirectory = join(runtime, "packages/natives/native");
  for (const entry of await readdir(nativePackage, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".node")) {
      await symlink(
        relative(nativeDirectory, join(nativePackage, entry.name)),
        join(nativeDirectory, entry.name),
      );
    }
  }
  return nativePackage;
}

export async function stageRuntime(context: BuildContext): Promise<string> {
  const { helper, repo, payload, root, target, runtime, bunPath } = context;
  await stageRuntimeSource(context);
  await installRuntimeClosure(context);
  await run([bunPath, "packages/collab-web/scripts/build-tool-views.ts"], runtime);
  await run(
    [bunPath, `--cwd=${join(runtime, "packages/stats")}`, "run", "gen:stats"],
    runtime,
  );
  for (const name of ["gateway", "package.json", "bun.lock"])
    await copy(join(helper, name), join(target, name));
  await copy(
    join(repo, "packages/omp/npm-patches"),
    join(root, "packages/omp/npm-patches"),
  );
  await run(runtimeInstallArgs(bunPath), target);
  for (const name of ["helper", "desktop"])
    await copy(
      join(repo, "dotfiles/dot_omp/agent/lib", name),
      join(root, "dotfiles/dot_omp/agent/lib", name),
    );
  await symlink("packages/omp-helper/node_modules", join(root, "node_modules"));
  const namespace = join(target, "node_modules/@oh-my-pi");
  await rm(namespace, { recursive: true });
  await symlink(
    relative(dirname(namespace), join(runtime, "node_modules/@oh-my-pi")),
    namespace,
  );
  await rm(join(root, "packages/omp"), { recursive: true });
  const nativePackage = await linkNativeRuntime(runtime, target);
  await mkdir(join(payload, "bin"), { recursive: true });
  await copyFile(bunPath, join(payload, "bin/bun"));
  await chmod(join(payload, "bin/bun"), 0o755);
  await run(
    [
      join(payload, "bin/bun"),
      "--eval",
      'import { visibleWidth, PtySession } from "@oh-my-pi/pi-natives"; import "@oh-my-pi/pi-coding-agent/launch/client"; if (visibleWidth("omp", 8) !== 3 || typeof PtySession !== "function") throw new Error("Native PTY runtime is unavailable");',
    ],
    runtime,
  );
  return nativePackage;
}
