#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { run } from "@dotfiles/core/commands";
import { runMain } from "@dotfiles/core/runtime";
import { object } from "@optique/core/constructs";
import { runParser } from "@optique/core/facade";
import { withDefault } from "@optique/core/modifiers";
import { argument, flag, option } from "@optique/core/primitives";
import { choice, string } from "@optique/core/valueparser";
import { Effect, FileSystem } from "effect";

const ROOT = process.env.DOTFILES_REPO ?? resolve(import.meta.dir, "../..");
const MACOS = process.platform === "darwin";

const updateSandbox = Effect.fn(function* (
  prefix: string,
  before: string,
  after: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(prefix, "Library/Homebrew/extend/os/mac/sandbox.rb");
  if (!(yield* fs.exists(path))) return;
  const source = yield* fs.readFileString(path);
  const updated = source.replaceAll(before, after);
  if (source !== updated) yield* fs.writeFileString(path, updated);
});

const deniedRule = "        (deny mach-lookup)\n";
const allowedRule = "        (allow mach-lookup)\n";

export const sandbox = (prefix: string, restore: boolean) =>
  updateSandbox(
    prefix,
    restore ? allowedRule : deniedRule,
    restore ? deniedRule : allowedRule,
  );

export const bundle = Effect.fn(function* (prefix: string, upgrade: boolean) {
  // Mark only our temporary rules so cleanup preserves existing allows and updates
  const temporaryRule = "        (allow mach-lookup) ; dotfiles bundle\n";
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        updateSandbox(prefix, deniedRule, temporaryRule),
        () => updateSandbox(prefix, temporaryRule, deniedRule).pipe(Effect.orDie),
      );
      yield* run([
        join(prefix, "bin/brew"),
        "bundle",
        "install",
        upgrade ? "--upgrade" : "--no-upgrade",
        "--file",
        join(ROOT, "Brewfile"),
      ]);
    }),
  );
});

if (import.meta.main) {
  const values = runParser(
    object({
      operation: argument(choice(["bundle", "sandbox", "restore"])),
      prefix: withDefault(
        option("--prefix", string({ metavar: "PATH" })),
        MACOS ? "/opt/homebrew" : "/home/linuxbrew/.linuxbrew",
      ),
      upgrade: withDefault(flag("--upgrade"), false),
    }),
    "homebrew.ts",
    Bun.argv.slice(2),
    {
      help: { option: { names: ["-h", "--help"] }, onShow: process.exit },
      onError: process.exit,
    },
  );
  runMain(
    Effect.gen(function* () {
      if (values.operation === "bundle") yield* bundle(values.prefix, values.upgrade);
      else yield* sandbox(values.prefix, values.operation === "restore");
    }),
  );
}
