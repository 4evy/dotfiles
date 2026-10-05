import { chmod, lstat, mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { files, reportArtifact, run } from "./common";
import type { BuildContext } from "./targets";
export async function packageDarwin(
  context: Extract<BuildContext, { darwin: true }>,
): Promise<void> {
  const {
    work,
    payload,
    output,
    epoch,
    version,
    release,
    distro,
    toolchain,
    source,
    manifest,
  } = context;
  await mkdir(join(payload, "share/omp-helper"), { recursive: true });
  await writeFile(
    join(payload, "bin/omp-helper"),
    `#!/bin/sh\nset -eu\nscript=$0\nwhile [ -L "$script" ]; do\n  link=$(readlink "$script")\n  case "$link" in /*) script=$link ;; *) script=$(dirname "$script")/$link ;; esac\ndone\nOMP_HELPER_PACKAGE_PATH=$(CDPATH= cd -P "$(dirname "$script")/.." && pwd)\nexport OMP_HELPER_PACKAGE_PATH\nexec "$OMP_HELPER_PACKAGE_PATH/bin/bun" "$OMP_HELPER_PACKAGE_PATH/lib/omp-helper/packages/omp-helper/gateway/main.ts" "$@"\n`,
  );
  await chmod(join(payload, "bin/omp-helper"), 0o755);
  await writeFile(
    join(payload, "share/omp-helper/manifest.json"),
    `${JSON.stringify({ protocolMajor: manifest.protocolMajor, version, platform: "darwin" })}\n`,
  );
  await writeFile(
    join(payload, "share/omp-helper/build.json"),
    `${JSON.stringify({ distro, architecture: process.arch, release, sourceDateEpoch: epoch, toolchain, runtimeSource: source }, null, 2)}\n`,
  );
  const canonicalPayload = await realpath(payload);
  for await (const path of files(payload)) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const link = await readlink(path);
      if (
        isAbsolute(link) ||
        !(await realpath(path)).startsWith(`${canonicalPayload}/`)
      )
        throw new Error(`Payload symlink escapes package: ${path} -> ${link}`);
    } else if (!info.isDirectory() && !info.isFile()) {
      throw new Error(`Unexpected payload file type: ${path}`);
    }
  }
  const artifact = join(
    output,
    `omp-helper-${version}.${release}-darwin-${process.arch}.tar.gz`,
  );
  await run(
    [
      "gtar",
      "--sort=name",
      `--mtime=@${epoch}`,
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--create",
      "--gzip",
      "--file",
      artifact,
      "--directory",
      payload,
      ".",
    ],
    work,
    { ...process.env, GZIP: "-n" },
  );
  await reportArtifact(artifact, context);
}
