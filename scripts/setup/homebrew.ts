#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { run } from "../../lib/typescript/commands.ts";

const ROOT = process.env.DOTFILES_REPO ?? resolve(import.meta.dir, "../..");
const MACOS = process.platform === "darwin";

function updateSandbox(prefix: string, before: string, after: string): void {
  const path = join(prefix, "Library/Homebrew/extend/os/mac/sandbox.rb");
  if (!existsSync(path)) return;
  const source = readFileSync(path, "utf8");
  const updated = source.replaceAll(before, after);
  if (source !== updated) writeFileSync(path, updated);
}

const deniedRule = "        (deny mach-lookup)\n";
const allowedRule = "        (allow mach-lookup)\n";

export function sandbox(prefix: string, restore: boolean): void {
  updateSandbox(
    prefix,
    restore ? allowedRule : deniedRule,
    restore ? deniedRule : allowedRule,
  );
}

export function bundle(prefix: string, upgrade: boolean): void {
  // Mark only our temporary rules so cleanup preserves existing allows and updates
  const temporaryRule = "        (allow mach-lookup) ; dotfiles bundle\n";
  try {
    updateSandbox(prefix, deniedRule, temporaryRule);
    run([
      join(prefix, "bin/brew"),
      "bundle",
      "install",
      upgrade ? "--upgrade" : "--no-upgrade",
      "--file",
      join(ROOT, "Brewfile"),
    ]);
  } finally {
    updateSandbox(prefix, temporaryRule, deniedRule);
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
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
  });
  const [command] = positionals;
  if (values.help)
    console.log(
      "Usage: bun homebrew.ts bundle|sandbox|restore [--prefix PATH] [--upgrade]",
    );
  else if (positionals.length !== 1) throw new Error("Expected one Homebrew operation");
  else if (command === "bundle") bundle(values.prefix, values.upgrade);
  else if (command === "sandbox" || command === "restore")
    sandbox(values.prefix, command === "restore");
  else throw new Error(`Unknown Homebrew operation: ${command}`);
}
