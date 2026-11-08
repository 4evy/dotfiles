import { join } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { writeJson } from "@dotfiles/core/files";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Schema } from "effect";
import { root } from "./paths.ts";

const dependencyMap = Schema.Record(Schema.String, Schema.String);
const manifestSchema = Schema.Struct({
  dependencies: Schema.optionalKey(dependencyMap),
  devDependencies: Schema.optionalKey(dependencyMap),
});

// Workspace OMP versions follow the locked AI input, not independent npm updates
// Run `bun run sync:omp` after manually updating that input
export const updateOmpDependencies = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { storePath } = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ storePath: Schema.String })),
  )(
    yield* output(["nix", "flake", "prefetch", "--json", "--inputs-from", root, "ai"], {
      cwd: root,
    }),
  );
  const { dependencies } = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ dependencies: dependencyMap })),
  )(
    yield* fs.readFileString(join(storePath, "apps/omp/runtime/upstream/package.json")),
  );
  const path = join(root, "package.json");
  const raw = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  )(yield* fs.readFileString(path));
  const manifest = yield* Schema.decodeUnknownEffect(manifestSchema)(raw);
  const updated = { ...raw };
  for (const key of ["dependencies", "devDependencies"] as const) {
    const section = manifest[key];
    if (!section) continue;
    const values = { ...section };
    for (const name of Object.keys(values)) {
      if (!name.startsWith("@oh-my-pi/")) continue;
      const version = dependencies[name];
      if (!version)
        return yield* Effect.fail(
          new DotfilesError(`The AI runtime does not declare ${name}`),
        );
      values[name] = version;
    }
    updated[key] = values;
  }
  yield* writeJson(path, updated);
});

if (import.meta.main)
  runMain(
    Effect.gen(function* () {
      yield* updateOmpDependencies();
      yield* run(["bun", "install", "--ignore-scripts", "--lockfile-only"], {
        cwd: root,
        capture: true,
      });
    }),
  );
