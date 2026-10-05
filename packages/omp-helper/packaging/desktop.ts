import { chmod, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { copy, run } from "./common";
import { type BuildContext, LINUX_ARCHITECTURES } from "./targets";
export async function stageDesktop(
  context: Extract<BuildContext, { darwin: false }>,
): Promise<void> {
  const { helper, work, payload, installPath, epoch, architecture } = context;
  const desktop = join(work, "desktop");
  for (const name of ["Cargo.toml", "Cargo.lock", "src"])
    await copy(join(helper, "desktop", name), join(desktop, name));
  const triple = LINUX_ARCHITECTURES[architecture].triple;
  const home = process.env.HOME;
  if (!process.env.CARGO_HOME && !home)
    throw new Error("HOME or CARGO_HOME is required");
  const cargoHome = resolve(process.env.CARGO_HOME ?? join(home ?? "", ".cargo"));
  const buildEnv = {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: undefined,
    CARGO_BUILD_TARGET: triple,
    CARGO_TARGET_DIR: join(work, "target"),
    RUSTFLAGS: `--remap-path-prefix=${work}=/build/omp-helper --remap-path-prefix=${cargoHome}=/build/cargo -C target-cpu=generic`,
    TZ: "UTC",
    LC_ALL: "C",
    SOURCE_DATE_EPOCH: epoch,
  };
  await run(
    ["cargo", "build", "--locked", "--release", "--target", triple],
    desktop,
    buildEnv,
  );
  await copyFile(
    join(work, "target", triple, "release/omp-helper-desktop"),
    join(payload, "bin/omp-helper-desktop"),
  );
  await writeFile(
    join(payload, "bin/omp-helper"),
    `#!/bin/sh\nexport OMP_HELPER_PACKAGE_PATH='${installPath}'\nexec '${installPath}/bin/bun' '${installPath}/lib/omp-helper/packages/omp-helper/gateway/main.ts' "$@"\n`,
  );
  await writeFile(
    join(payload, "bin/omp-runtime"),
    `#!/bin/sh\nexec '${installPath}/bin/bun' '${installPath}/lib/omp-runtime/packages/coding-agent/src/cli.ts' "$@"\n`,
  );
  for (const name of ["omp-helper", "omp-runtime", "omp-helper-desktop", "bun"])
    await chmod(join(payload, "bin", name), 0o755);
  for (const name of [
    "manifest.json",
    ...(await readdir(helper)).filter((name) => name.endsWith(".in")),
  ])
    await copy(join(helper, name), join(payload, "share/omp-helper", name));
  const extension = join(payload, "share/omp-helper/gnome");
  await mkdir(extension, { recursive: true });
  await run(
    [
      "bun",
      "build",
      join(helper, "gnome/extension.ts"),
      "--format=esm",
      "--target=browser",
      "--external=gi://*",
      "--external=resource:///*",
      `--outfile=${join(extension, "extension.js")}`,
    ],
    helper,
  );
  await copy(join(helper, "gnome/metadata.json"), join(extension, "metadata.json"));
}
