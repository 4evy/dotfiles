#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
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
  runMain(
    Effect.gen(function* () {
      const { values, positionals } = yield* Effect.try({
        try: () =>
          parseArgs({
            args: Bun.argv.slice(2),
            allowPositionals: true,
            options: {
              prefix: {
                type: "string",
                default: MACOS ? "/opt/homebrew" : "/home/linuxbrew/.linuxbrew",
              },
              upgrade: { type: "boolean", default: false },
              help: { type: "boolean", short: "h" },
            },
          }),
        catch: (error) => new DotfilesError(String(error)),
      });
      const [command] = positionals;
      if (values.help)
        yield* Effect.sync(() =>
          console.log(
            "Usage: bun homebrew.ts bundle|sandbox|restore [--prefix PATH] [--upgrade]",
          ),
        );
      else if (positionals.length !== 1)
        return yield* Effect.fail(new DotfilesError("Expected one Homebrew operation"));
      else if (command === "bundle") yield* bundle(values.prefix, values.upgrade);
      else if (command === "sandbox" || command === "restore")
        yield* sandbox(values.prefix, command === "restore");
      else
        return yield* Effect.fail(
          new DotfilesError(`Unknown Homebrew operation: ${command}`),
        );
    }),
  );
}
