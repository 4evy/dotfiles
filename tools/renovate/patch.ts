import { join } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { writeIfChanged, writeJson } from "@dotfiles/core/files";
import { download } from "@dotfiles/core/http";
import { Effect, FileSystem, Schema } from "effect";
import { root } from "./paths.ts";

export const updateRenovatePatch = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = join(root, ".github/renovate");
  const path = join(directory, "package.json");
  const raw = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  )(yield* fs.readFileString(path));
  const manifest = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      devDependencies: Schema.Struct({ renovate: Schema.String }),
      patchedDependencies: Schema.Record(Schema.String, Schema.String),
    }),
  )(raw);
  const version = manifest.devDependencies.renovate;
  const previousPatches = Object.entries(manifest.patchedDependencies).filter(
    ([name]) => name.startsWith("renovate@"),
  );
  const [previousPatch] = previousPatches;
  if (previousPatches.length !== 1 || !previousPatch)
    return yield* Effect.fail(
      new DotfilesError("Expected one commits-only Renovate patch"),
    );
  const [previous, patchPath] = previousPatch;
  if (previous === `renovate@${version}`) return;

  // Never accept an unpatched Renovate upgrade: PRs and issues are forbidden
  // Require the complete old patch to apply before changing its version binding
  const staging = yield* fs.makeTempDirectoryScoped({ prefix: "renovate-patch-" });
  const metadataData = yield* download(
    `https://registry.npmjs.org/renovate/${version}`,
    (response) => response.json,
  );
  const metadata = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      dist: Schema.Struct({ tarball: Schema.String, integrity: Schema.String }),
    }),
  )(metadataData);
  yield* Schema.decodeUnknownEffect(Schema.URLFromString)(metadata.dist.tarball);
  const archive = new Uint8Array(
    yield* download(metadata.dist.tarball, (response) => response.arrayBuffer),
  );
  const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(archive).digest("base64")}`;
  if (integrity !== metadata.dist.integrity)
    return yield* Effect.fail(
      new DotfilesError("Renovate archive integrity check failed"),
    );
  const archivePath = join(staging, "source.tar.gz");
  yield* fs.writeFile(archivePath, archive);
  yield* run(["tar", "-xzf", archivePath, "--strip-components=1", "-C", staging], {
    cwd: root,
    capture: true,
  });
  yield* fs.remove(archivePath);
  yield* run(["git", "init", "--quiet"], { cwd: staging, capture: true });
  yield* run(["git", "add", "--all", "--force"], { cwd: staging, capture: true });
  const oldPatch = join(directory, patchPath);
  yield* run(["git", "apply", "--check", oldPatch], { cwd: staging, capture: true });
  yield* run(["git", "apply", oldPatch], { cwd: staging, capture: true });
  const newPatch = `patches/renovate@${version}.patch`;
  // Bun needs exact hunk coordinates, even when git apply accepts old offsets
  const patch = yield* output(
    [
      "git",
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ],
    { cwd: staging },
  );
  yield* writeIfChanged(join(directory, newPatch), `${patch}\n`);
  const patchedDependencies = { ...manifest.patchedDependencies };
  delete patchedDependencies[previous];
  patchedDependencies[`renovate@${version}`] = newPatch;
  yield* writeJson(path, { ...raw, patchedDependencies });
  yield* fs.remove(oldPatch);
});
