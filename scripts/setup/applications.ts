#!/usr/bin/env bun
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { run as runCommand } from "../../lib/typescript/commands.ts";
import { writeIfChanged } from "../../lib/typescript/files.ts";

const macOS = process.platform === "darwin";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object in application configuration");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a configuration string");
  return value;
}

function run(
  argv: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string;
    capture?: boolean;
    quiet?: boolean;
  } = {},
): string {
  return runCommand(argv, {
    ...options,
    outputMode: options.quiet ? "discard" : "inherit",
    stderr: "inherit",
  }).stdout;
}

function avatar(profile: string, cache: string): void {
  using workspace = mkdtempDisposableSync(join(cache, "avatar."));
  const temporary = workspace.path;
  const download = join(temporary, "avatar");
  const png = join(temporary, "avatar.png");
  run([
    "curl",
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "https://github.com/4evy.png?size=256",
    "--output",
    download,
  ]);
  run([
    "magick",
    download,
    "-auto-orient",
    "-strip",
    "-resize",
    "256x256^",
    "-gravity",
    "center",
    "-extent",
    "256x256",
    `PNG:${png}`,
  ]);
  const target = join(profile, "Custom Avatar Picture.png");
  if (!existsSync(target) || !readFileSync(target).equals(readFileSync(png)))
    copyFileSync(png, target);
}

function privatePayload(root: string): Record<string, unknown> {
  const env = { ...process.env };
  if (macOS) env.SOPS_AGE_KEY_CMD = join(root, "dotfiles/home/.local/lib/sops/sops.sh");
  const privateConfig = object(
    JSON.parse(
      run(
        [
          "sops",
          "decrypt",
          "--output-type",
          "json",
          join(root, "secrets/secrets.yaml"),
        ],
        { env, capture: true },
      ),
    ),
  );
  const payload: Record<string, unknown> = {};
  const allowlist = privateConfig["chromium-cookie-allowed-for-urls"] ?? [];
  if (
    !Array.isArray(allowlist) ||
    !allowlist.every((value) => typeof value === "string")
  )
    throw new Error("Invalid Chromium cookie allowlist");
  if (allowlist.length) payload.cookie_allowlist = allowlist;
  if (process.env.OP_ACCOUNT) {
    const token = Bun.spawnSync(["op", "read", "op://Private/Refined GitHub/token"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const value = token.stdout.toString().trim();
    if (token.exitCode === 0 && value)
      payload.extension_values = { "refined-github-personal-token": value };
  }
  return payload;
}

export function helium(): void {
  const root = resolve(import.meta.dir, "../..");
  const configPath = join(root, "browser/helium.toml");
  const config = object(
    object(Bun.TOML.parse(readFileSync(configPath, "utf8"))).browser,
  );
  const platform = macOS ? "macos" : "linux";
  const home = homedir();
  const variables = {
    home,
    config_home: process.env.XDG_CONFIG_HOME || join(home, ".config"),
    data_home: process.env.XDG_DATA_HOME || join(home, ".local/share"),
  };
  const expand = (template: string): string => {
    for (const [key, value] of Object.entries(variables))
      template = template.replaceAll(`\${${key}}`, value);
    return template;
  };
  const pattern = macOS
    ? "^/Applications/(Nix Apps/)?Helium[.]app/Contents/MacOS/Helium([[:space:]]|$)"
    : "helium";
  const running = Bun.spawnSync(["pgrep", macOS ? "-f" : "-x", pattern], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (running.exitCode !== 0 && running.exitCode !== 1)
    throw new Error("Could not inspect Helium processes");
  const applyProfile = running.exitCode === 1;
  const cache = join(
    process.env.XDG_CACHE_HOME ?? join(home, ".cache"),
    "dotfiles/helium",
  );
  mkdirSync(cache, { recursive: true });
  if (applyProfile) {
    const profile = expand(string(object(object(config.paths)[platform]).profile_dir));
    mkdirSync(profile, { recursive: true });
    avatar(profile, cache);
  } else {
    // Launcher updates are safe while Chromium owns its profile
    console.log("Helium is running, refreshing launchers without profile changes");
  }
  run(
    [
      "tweezle",
      "apply",
      configPath,
      "--platform",
      platform,
      "--install-dir",
      cache,
      "--bin-dir",
      join(home, ".local/bin"),
      ...(applyProfile ? ["--input", "-"] : ["--no-profile"]),
    ],
    {
      ...(applyProfile ? { input: JSON.stringify(privatePayload(root)) } : {}),
      quiet: true,
    },
  );
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
  const operations: Record<string, () => void> = { helium, rustdesk };
  const usage = "Usage: applications.ts helium|rustdesk";
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
