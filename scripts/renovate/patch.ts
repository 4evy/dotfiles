import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import * as v from "valibot";
import { writeJson } from "../../lib/typescript/files.ts";
import { download } from "../../lib/typescript/http.ts";
import { run } from "../../lib/typescript/process.ts";
import { withTemporaryDirectory } from "../../lib/typescript/resources.ts";
import { root } from "./process.ts";

export async function updateRenovatePatch() {
  const directory = join(root, ".github/renovate");
  const path = join(directory, "package.json");
  const manifest = await Bun.file(path).json();
  const version: string = manifest.devDependencies.renovate;
  const [previous] = Object.keys(manifest.patchedDependencies);
  if (!previous) throw new Error("The commits-only Renovate patch is missing");
  if (previous === `renovate@${version}`) return;

  // Never accept an unpatched Renovate upgrade: PRs and issues are forbidden
  // Under every circumstance, this bot may only add commits on top of master
  // Require the complete old patch to apply before changing its version binding
  return Effect.runPromise(
    withTemporaryDirectory("renovate-patch-", (staging) =>
      Effect.gen(function* () {
        const response = yield* download(
          `https://registry.npmjs.org/renovate/${version}`,
        );
        const metadata = v.parse(
          v.object({
            dist: v.object({
              tarball: v.pipe(v.string(), v.url()),
              integrity: v.string(),
            }),
          }),
          yield* Effect.tryPromise(() => response.json()),
        );
        const tarball = yield* download(metadata.dist.tarball);
        const archive = new Uint8Array(
          yield* Effect.tryPromise(() => tarball.arrayBuffer()),
        );
        const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(archive).digest("base64")}`;
        if (integrity !== metadata.dist.integrity)
          return yield* Effect.fail(
            new Error("Renovate archive integrity check failed"),
          );
        const archivePath = join(staging, "source.tar.gz");
        yield* Effect.tryPromise(() => Bun.write(archivePath, archive));
        yield* run(["tar", "-xzf", archivePath, "--strip-components=1", "-C", staging]);
        const oldPatch = join(directory, manifest.patchedDependencies[previous]);
        yield* run(["git", "apply", "--check", oldPatch], { cwd: staging });
        yield* run(["git", "apply", oldPatch], { cwd: staging });
        const newPatch = `patches/renovate@${version}.patch`;
        const content = yield* Effect.tryPromise(() => Bun.file(oldPatch).text());
        yield* Effect.tryPromise(() => Bun.write(join(directory, newPatch), content));
        manifest.patchedDependencies = { [`renovate@${version}`]: newPatch };
        yield* Effect.tryPromise(() => writeJson(path, manifest));
        yield* Effect.tryPromise(() => rm(oldPatch));
      }),
    ),
  );
}
