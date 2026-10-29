#!/usr/bin/env bun
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { type RuntimeServices, runMain } from "@dotfiles/core/runtime";
import { buildHjemOutput } from "@dotfiles/home/nix";
import { HooksSchema, ManifestSchema } from "@dotfiles/home/schema";
import { Effect, FileSystem, Schema } from "effect";
import { validateXML } from "./xml.ts";

const repository = resolve(import.meta.dir, "../../..");
const platforms = ["darwin", "fedora", "nixos"];
type Validator = (
  contents: string,
  path: string,
) => Effect.Effect<unknown, DotfilesError, RuntimeServices>;
const bash: Validator = (_, path) => run(["bash", "-n", path], { cwd: repository });
const zsh: Validator = (_, path) => run(["zsh", "-n", path], { cwd: repository });
const js = new Bun.Transpiler({ loader: "js" });
const ts = new Bun.Transpiler({ loader: "ts" });
const jsx = new Bun.Transpiler({ loader: "jsx" });
const tsx = new Bun.Transpiler({ loader: "tsx" });
// Transpilers and parsers are synchronous foreign-library validation boundaries
const syntax =
  (parse: (contents: string) => unknown): Validator =>
  (contents) =>
    Effect.try({
      try: () => parse(contents),
      catch: (error) => new DotfilesError(String(error)),
    });
const scripts: Record<string, Validator> = {
  ".js": syntax((contents) => js.transformSync(contents)),
  ".mjs": syntax((contents) => js.transformSync(contents)),
  ".cjs": syntax((contents) => js.transformSync(contents)),
  ".ts": syntax((contents) => ts.transformSync(contents)),
  ".mts": syntax((contents) => ts.transformSync(contents)),
  ".cts": syntax((contents) => ts.transformSync(contents)),
  ".jsx": syntax((contents) => jsx.transformSync(contents)),
  ".tsx": syntax((contents) => tsx.transformSync(contents)),
  ".bash": bash,
  ".sh": bash,
  ".zsh": zsh,
};
const validators: Record<string, Validator> = {
  ...scripts,
  ".json": syntax(JSON.parse),
  ".toml": syntax(Bun.TOML.parse),
  ".plist": syntax(validateXML),
  ".xml": syntax(validateXML),
  ".tmTheme": syntax(validateXML),
  ".zshenv": zsh,
  ".zshrc": zsh,
  ".zprofile": zsh,
  ".bashenv": bash,
  ".bashrc": bash,
  ".bash_profile": bash,
};
const shells: Record<string, Validator> = { bash, sh: bash, zsh };

runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const platform = Bun.argv[2];
    if (!platform || !platforms.includes(platform) || Bun.argv.length !== 3)
      return yield* Effect.fail(
        new DotfilesError(
          `Usage: bun home/deploy/check/home.ts ${platforms.join("|")}`,
        ),
      );
    const output = yield* buildHjemOutput(repository, "hjemHome", {
      ...process.env,
      HJEM_WORKING_TREE: repository,
      HJEM_PLATFORM: platform === "darwin" ? "darwin" : "linux",
    });
    const readJson = Effect.fn("readGeneratedJson")(function* (name: string) {
      const text = yield* fs.readFileString(join(output, name));
      return yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (error) => new DotfilesError(`Invalid ${name}: ${error}`),
      });
    });
    const manifest = yield* Schema.decodeUnknownEffect(ManifestSchema)(
      yield* readJson("manifest.json"),
    );
    const hooks = yield* Schema.decodeUnknownEffect(HooksSchema)(
      yield* readJson("hooks.json"),
    );
    const paths = [
      // Only Nix-generated home sources need this check, not external packages
      ...manifest.files.filter(({ source }) =>
        /^[a-z0-9]{32}-hjem-/.test(basename(source)),
      ),
      ...hooks.flatMap(({ command }) =>
        command
          .filter(
            (path) =>
              isAbsolute(path) &&
              (basename(path).startsWith("hjem-hook-") || scripts[extname(path)]),
          )
          .map((source) => ({ source, target: source })),
      ),
    ];
    let checked = 0;
    for (const { source, target } of paths) {
      const info = yield* fs
        .stat(source)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        );
      if (info?.type !== "File") continue;
      const contents = yield* fs.readFileString(source);
      // A store source can lose its extension, and dotfiles have no extname
      const extension = extname(target) || basename(target);
      let validate = Object.hasOwn(validators, extension)
        ? validators[extension]
        : undefined;
      if (!validate && contents.startsWith("#!")) {
        const [interpreter, ...args] =
          contents.slice(2).split("\n", 1)[0]?.trim().split(/\s+/) ?? [];
        const program = basename(interpreter ?? "");
        // env -S splits the remaining shebang into a command and its arguments
        const command = program === "env" ? args[args[0] === "-S" ? 1 : 0] : program;
        const shell = basename(command ?? "");
        if (Object.hasOwn(shells, shell)) validate = shells[shell];
      }
      if (!validate) continue;
      yield* validate(contents, source).pipe(
        Effect.mapError(
          (cause) =>
            new DotfilesError(
              `Generated Hjem target: ${target} from ${source} (${platform})`,
              { cause },
            ),
        ),
      );
      checked++;
    }
    console.log(`${platform}: checked ${checked} generated home files and hooks`);
  }),
);
