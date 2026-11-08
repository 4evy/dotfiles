import { dirname, extname, join, resolve } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Schema } from "effect";

const root = resolve(import.meta.dir, "../../..");
const DEPLOYED_SOURCE_PREFIX = "home/files/";
const source = join(root, "home");
// TypeScript's supported source extensions, including JSX and module variants
const scriptExtensions: Record<string, true> = {
  ".ts": true,
  ".tsx": true,
  ".mts": true,
  ".cts": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".cjs": true,
};

const stageSource = Effect.fn("stageTypeScriptSource")(function* (
  original: string,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(target), { recursive: true });
  yield* fs.copyFile(original, target);
  // Preserve each deployed package's own dependencies in the staged home tree
  if (original.endsWith("/package.json")) {
    const modules = join(dirname(original), "node_modules");
    if (yield* fs.exists(modules))
      yield* fs.symlink(modules, join(dirname(target), "node_modules"));
  }
});

runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const staging = yield* fs.makeTempDirectoryScoped({
      prefix: "dotfiles-typecheck-",
    });
    const discovery = yield* output(
      [
        "git",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "home/files",
      ],
      { cwd: root },
    );
    // Stage the native home tree so workspace metadata cannot become a target
    const sources = new Map<string, string>();
    for (const file of discovery.split("\0")) {
      if (!file.startsWith(DEPLOYED_SOURCE_PREFIX)) continue;
      const extension = extname(file);
      // JSON includes imported data and package metadata needed for resolution
      if (!scriptExtensions[extension] && extension !== ".json") continue;
      const target = file.slice(DEPLOYED_SOURCE_PREFIX.length);
      if (sources.has(target))
        return yield* Effect.fail(
          new DotfilesError(`Duplicate staged path: ${target}`),
        );
      const original = join(root, file);
      if (!(yield* fs.exists(original))) continue;
      sources.set(target, file);
      yield* stageSource(original, join(staging, target));
    }
    const text = yield* fs.readFileString(join(source, "tsconfig.json"));
    const config = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(text);
    yield* fs.writeFileString(
      join(staging, "tsconfig.json"),
      JSON.stringify({
        ...config,
        extends: join(source, "tsconfig.json"),
        include: [],
        files: [...sources.keys()].filter((path) => scriptExtensions[extname(path)]),
      }),
    );
    // Deployed package checks use the workspace's development dependencies
    yield* fs.symlink(join(root, "node_modules"), join(staging, "node_modules"));
    // Keep diagnostics relative even when macOS resolves /var to /private/var
    const compiler = yield* run(
      [
        join(root, "node_modules/.bin/tsc"),
        "-p",
        ".",
        "--pretty",
        "false",
        ...Bun.argv.slice(2),
      ],
      {
        cwd: staging,
        capture: true,
        check: false,
        stderr: "inherit",
        stdin: "ignore",
      },
    );
    process.stdout.write(
      compiler.stdout.replace(/^(.+?)(\(\d+,\d+\):)/gm, (line, file, location) =>
        sources.has(file) ? `${sources.get(file)}${location}` : line,
      ),
    );
    process.exitCode = compiler.code;
  }),
);
