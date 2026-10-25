import { mkdtempDisposable, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { writeIfChanged, writeJson } from "../../lib/typescript/files.ts";
import { download, root, run } from "./process.ts";

export async function updateRenovatePatch() {
  const directory = join(root, ".github/renovate");
  const path = join(directory, "package.json");
  const manifest = v.parse(
    v.looseObject({
      devDependencies: v.looseObject({ renovate: v.string() }),
      patchedDependencies: v.record(v.string(), v.string()),
    }),
    await Bun.file(path).json(),
  );
  const version = manifest.devDependencies.renovate;
  const previousPatches = Object.entries(manifest.patchedDependencies).filter(
    ([name]) => name.startsWith("renovate@"),
  );
  const [previousPatch] = previousPatches;
  if (previousPatches.length !== 1 || !previousPatch)
    throw new Error("Expected one commits-only Renovate patch");
  const [previous, patchPath] = previousPatch;
  if (previous === `renovate@${version}`) return;

  // Never accept an unpatched Renovate upgrade: PRs and issues are forbidden
  // Under every circumstance, this bot may only add commits on top of master
  // Require the complete old patch to apply before changing its version binding
  await using workspace = await mkdtempDisposable(join(tmpdir(), "renovate-patch-"));
  const staging = workspace.path;
  const response = await download(`https://registry.npmjs.org/renovate/${version}`);
  const metadata = v.parse(
    v.object({
      dist: v.object({
        tarball: v.pipe(v.string(), v.url()),
        integrity: v.string(),
      }),
    }),
    await response.json(),
  );
  const tarball = await download(metadata.dist.tarball);
  const archive = new Uint8Array(await tarball.arrayBuffer());
  const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(archive).digest("base64")}`;
  if (integrity !== metadata.dist.integrity)
    throw new Error("Renovate archive integrity check failed");
  const archivePath = join(staging, "source.tar.gz");
  await Bun.write(archivePath, archive);
  await run(["tar", "-xzf", archivePath, "--strip-components=1", "-C", staging]);
  await rm(archivePath);
  await run(["git", "init", "--quiet"], staging);
  await run(["git", "add", "--all", "--force"], staging);
  const oldPatch = join(directory, patchPath);
  await run(["git", "apply", "--check", oldPatch], staging);
  await run(["git", "apply", oldPatch], staging);
  const newPatch = `patches/renovate@${version}.patch`;
  // Bun needs exact hunk coordinates, even when git apply accepts old offsets
  const patch = await run(
    [
      "git",
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ],
    staging,
  );
  writeIfChanged(join(directory, newPatch), `${patch}\n`);
  delete manifest.patchedDependencies[previous];
  manifest.patchedDependencies[`renovate@${version}`] = newPatch;
  writeJson(path, manifest);
  await rm(oldPatch);
}
