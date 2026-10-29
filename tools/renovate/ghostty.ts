import { join } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { download } from "@dotfiles/core/http";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { root } from "./paths.ts";

export const validateGhostty = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const sources = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        ghostty: Schema.Struct({ canonical: Schema.String, revision: Schema.String }),
      }),
    ),
  )(yield* output(["nix", "eval", ".#patchStackSources", "--json"], { cwd: root }));
  const patches = yield* output(["nix", "eval", ".#lib.patchesSource", "--raw"], {
    cwd: root,
  });
  // Renovate runs on x86_64 Linux, matching this pinned compiler input
  const { storePath: compiler } = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ storePath: Schema.String })),
  )(
    yield* output(
      [
        "nix",
        "flake",
        "prefetch",
        "--json",
        "--inputs-from",
        ".",
        "source-ghostty-zig-x86-64-linux",
      ],
      { cwd: root },
    ),
  );
  if (!compiler)
    return yield* Effect.fail(new DotfilesError("Missing Ghostty compiler store path"));
  const repository = sources.ghostty.canonical.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/,
  )?.[1];
  if (!repository)
    return yield* Effect.fail(new DotfilesError("Unsupported Ghostty source endpoint"));
  const staging = yield* fs.makeTempDirectoryScoped({ prefix: "ghostty-update-" });
  const source = join(staging, "source");
  const zig = join(staging, "zig");
  const cache = join(staging, "zig-cache");
  yield* fs.makeDirectory(source);
  yield* fs.makeDirectory(zig);
  yield* fs.makeDirectory(join(cache, "tmp"), { recursive: true });
  const archive = join(staging, "source.tar.gz");
  yield* download(
    `https://codeload.github.com/${repository}/tar.gz/${sources.ghostty.revision}`,
    (response) => Stream.run(response.stream, fs.sink(archive)),
  );
  yield* run(["tar", "-xzf", archive, "--strip-components=1", "-C", source], {
    cwd: root,
    capture: true,
  });
  yield* run(["tar", "-xJf", compiler, "--strip-components=1", "-C", zig], {
    cwd: root,
    capture: true,
  });
  const series = join(patches, "stacks/ghostty/patches");
  const entries = (yield* fs.readFileString(join(series, "series")))
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith("#"));
  yield* Effect.forEach(
    entries,
    (entry) =>
      run(["git", "apply", join(series, entry)], { cwd: source, capture: true }),
    { discard: true },
  );
  yield* run([join(zig, "zig"), "build", "--help"], {
    cwd: source,
    env: { ZIG_GLOBAL_CACHE_DIR: cache },
    capture: true,
  });
});
