#!/usr/bin/env bun
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeIfChanged } from "../../lib/typescript/files.ts";

const macOS = process.platform === "darwin";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object in application configuration");
  return value as Record<string, unknown>;
}

// RustDesk options are strings, including numeric ports and empty flags
// Bun normalizes changed TOML and drops comments, semantic no-ops keep bytes
export function updateTomlOptions(path: string, values: Record<string, string>): void {
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const config = object(Bun.TOML.parse(original));
  const options = config.options === undefined ? {} : object(config.options);
  let changed = false;
  for (const [key, value] of Object.entries(values)) {
    if (options[key] === value) continue;
    options[key] = value;
    changed = true;
  }
  if (!changed) return;
  config.options = options;
  const mode = statSync(path, { throwIfNoEntry: false })?.mode;
  writeIfChanged(
    path,
    Bun.TOML.stringify(config),
    mode === undefined ? 0o600 : mode & 0o7777,
  );
}

function linkRustdesk(home: string): void {
  const link = join(home, ".local/bin/rustdesk");
  const target = "/Applications/RustDesk.app/Contents/MacOS/RustDesk";
  if (!existsSync(target)) return;
  const state = lstatSync(link, { throwIfNoEntry: false });
  if (state?.isSymbolicLink() && readlinkSync(link) === target) return;
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(target, link);
}

export function rustdesk(): void {
  const home = homedir();
  const directory = macOS
    ? join(home, "Library/Preferences/com.carriez.RustDesk")
    : join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "rustdesk");
  mkdirSync(directory, { recursive: true });
  const options: Record<string, string> = {
    "direct-server": "Y",
    "direct-access-port": "21118",
  };
  if (!macOS) options["stop-service"] = "";
  updateTomlOptions(join(directory, "RustDesk2.toml"), options);
  if (macOS) linkRustdesk(home);
}

if (import.meta.main) {
  const operations: Record<string, () => void> = { rustdesk };
  const usage = "Usage: applications.ts rustdesk";
  const args = process.argv.slice(2);
  const command = args[0];
  if (args.length !== 1 || command === undefined) throw new Error(usage);
  const operation = Object.hasOwn(operations, command)
    ? operations[command]
    : undefined;
  if (command === "-h" || command === "--help") console.log(usage);
  else if (operation) operation();
  else throw new Error(usage);
}
