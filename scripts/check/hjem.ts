#!/usr/bin/env bun
import { statSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import * as v from "valibot";
import { run } from "../../lib/typescript/commands.ts";
import { buildHjemOutput } from "../hjem/nix.ts";
import { validateXML } from "./xml.ts";

const repository = resolve(import.meta.dir, "../..");
const platforms = ["darwin", "fedora", "nixos"];
const platform = Bun.argv[2];
if (!platform || !platforms.includes(platform) || Bun.argv.length !== 3)
  throw new Error(`Usage: bun scripts/check/hjem.ts ${platforms.join("|")}`);

type Validator = (contents: string, path: string) => void;
const bash: Validator = (_, path) => {
  run(["bash", "-n", path], { cwd: repository });
};
const zsh: Validator = (_, path) => {
  run(["zsh", "-n", path], { cwd: repository });
};
const js = new Bun.Transpiler({ loader: "js" });
const ts = new Bun.Transpiler({ loader: "ts" });
const jsx = new Bun.Transpiler({ loader: "jsx" });
const tsx = new Bun.Transpiler({ loader: "tsx" });
const scripts: Record<string, Validator> = {
  ".js": (contents) => js.transformSync(contents),
  ".mjs": (contents) => js.transformSync(contents),
  ".cjs": (contents) => js.transformSync(contents),
  ".ts": (contents) => ts.transformSync(contents),
  ".mts": (contents) => ts.transformSync(contents),
  ".cts": (contents) => ts.transformSync(contents),
  ".jsx": (contents) => jsx.transformSync(contents),
  ".tsx": (contents) => tsx.transformSync(contents),
  ".bash": bash,
  ".sh": bash,
  ".zsh": zsh,
};
const validators: Record<string, Validator> = {
  ...scripts,
  ".json": (contents) => JSON.parse(contents),
  ".toml": Bun.TOML.parse,
  ".plist": validateXML,
  ".xml": validateXML,
  ".tmTheme": validateXML,
  ".zshenv": zsh,
  ".zshrc": zsh,
  ".zprofile": zsh,
  ".bashenv": bash,
  ".bashrc": bash,
  ".bash_profile": bash,
};
const shells: Record<string, Validator> = { bash, sh: bash, zsh };

const output = await buildHjemOutput(repository, "hjemHome", {
  ...process.env,
  HJEM_WORKING_TREE: repository,
  HJEM_PLATFORM: platform === "darwin" ? "darwin" : "linux",
});
const manifest = v.parse(
  v.object({ files: v.array(v.object({ source: v.string(), target: v.string() })) }),
  await Bun.file(join(output, "manifest.json")).json(),
);
const hooks = v.parse(
  v.array(v.object({ command: v.array(v.string()) })),
  await Bun.file(join(output, "hooks.json")).json(),
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
  if (!statSync(source, { throwIfNoEntry: false })?.isFile()) continue;
  const contents = await Bun.file(source).text();
  // A store source can lose its extension, and dotfiles have no extname
  const syntax = extname(target) || basename(target);
  let validate = Object.hasOwn(validators, syntax) ? validators[syntax] : undefined;
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
  try {
    validate(contents, source);
    checked++;
  } catch (error) {
    throw new Error(`Generated Hjem target: ${target} from ${source} (${platform})`, {
      cause: error,
    });
  }
}
console.log(`${platform}: checked ${checked} generated home files and hooks`);
