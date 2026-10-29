import { dirname, extname, join, resolve } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Schema } from "effect";

const root = resolve(import.meta.dir, "../../..");
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
      if (!file.startsWith("home/files/")) continue;
      const extension = extname(file);
      // JSON includes imported data and package metadata needed for resolution
      if (!scriptExtensions[extension] && extension !== ".json") continue;
      const target = file.slice("home/files/".length);
      if (sources.has(target))
        return yield* Effect.fail(
          new DotfilesError(`Duplicate staged path: ${target}`),
        );
      const original = join(root, file);
      if (!(yield* fs.exists(original))) continue;
      sources.set(target, file);
      yield* fs.makeDirectory(dirname(join(staging, target)), { recursive: true });
      yield* fs.copyFile(original, join(staging, target));
    }
    const text = yield* fs.readFileString(join(source, "tsconfig.json"));
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (error) =>
        new DotfilesError(`Invalid home TypeScript configuration: ${error}`),
    });
    const config = yield* Schema.decodeUnknownEffect(
      Schema.Record(Schema.String, Schema.Unknown),
    )(parsed);
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
        join(root, "node_modules/.bin/tsrs"),
        "-p",
        ".",
        "--pretty",
        "false",
        ...Bun.argv.slice(2),
      ],
      { cwd: staging, capture: true, check: false, stderr: "inherit", stdin: "ignore" },
    );
    process.stdout.write(
      compiler.stdout.replace(/^(.+?)(\(\d+,\d+\):)/gm, (line, file, location) =>
        sources.has(file) ? `${sources.get(file)}${location}` : line,
      ),
    );
    process.exitCode = compiler.code;
  }),
);
