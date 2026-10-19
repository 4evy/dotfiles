#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { run } from "../../lib/typescript/commands.ts";

const ROOT = process.env.DOTFILES_REPO ?? resolve(import.meta.dir, "../..");
const MACOS = process.platform === "darwin";

export function sandbox(prefix: string, restore: boolean): void {
  const path = join(prefix, "Library/Homebrew/extend/os/mac/sandbox.rb");
  if (!existsSync(path)) return;
  const before = restore ? "allow" : "deny";
  const after = restore ? "deny" : "allow";
  const source = readFileSync(path, "utf8");
  const updated = source.replaceAll(
    `        (${before} mach-lookup)\n`,
    `        (${after} mach-lookup)\n`,
  );
  if (source !== updated) writeFileSync(path, updated);
}

export function bundle(prefix: string, upgrade: boolean): void {
  let content = readFileSync(join(ROOT, "Brewfile"), "utf8");
  const privateFile = join(homedir(), ".config/homebrew/Brewfile.private");
  if (existsSync(privateFile)) content += `\n${readFileSync(privateFile, "utf8")}`;
  sandbox(prefix, false);
  const temporary = mkdtempSync(join(tmpdir(), "dotfiles-brew."));
  try {
    const brewfile = join(temporary, "Brewfile");
    writeFileSync(brewfile, content);
    run([
      join(prefix, "bin/brew"),
      "bundle",
      "install",
      upgrade ? "--upgrade" : "--no-upgrade",
      "--file",
      brewfile,
    ]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    sandbox(prefix, true);
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
