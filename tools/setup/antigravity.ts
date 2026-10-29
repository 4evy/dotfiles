#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../../lib/typescript/commands.ts";

const releases =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";

export function installAntigravity(): void {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(`Unsupported Antigravity platform: ${process.platform}`);
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  if (arch !== "amd64" && arch !== "arm64")
    throw new Error(`Unsupported Antigravity architecture: ${process.arch}`);

  // Keep existing, self-updating Apps, including versions newer than the cask
  if (process.platform === "darwin" && !existsSync("/Applications/Antigravity.app"))
    run(["brew", "install", "--cask", "antigravity"]);

  const bin = join(homedir(), ".local/bin");
  const target = join(bin, "agy");
  const installed = lstatSync(target, { throwIfNoEntry: false });
  if (installed) {
    if (!installed.isFile())
      throw new Error(`Refusing to replace an existing non-file at ${target}`);
    accessSync(target, constants.X_OK);
    console.log(`Antigravity CLI already installed at ${target}, using self-updates`);
    return;
  }

  mkdirSync(bin, { recursive: true });
  using workspace = mkdtempDisposableSync(join(bin, ".antigravity-"));
  const platform = `${process.platform}_${arch}`;
  const manifestPath = join(workspace.path, "manifest.json");
  run(["curl", "-fsSL", "-o", manifestPath, `${releases}/manifests/${platform}.json`]);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    typeof manifest.url !== "string" ||
    !manifest.url.startsWith("https://") ||
    typeof manifest.sha512 !== "string" ||
    !/^[0-9a-f]{128}$/.test(manifest.sha512)
  )
    throw new Error("Invalid Antigravity CLI release manifest");

  const payload = join(workspace.path, "payload");
  run(["curl", "-fsSL", "-o", payload, manifest.url]);
  if (
    createHash("sha512").update(readFileSync(payload)).digest("hex") !== manifest.sha512
  )
    throw new Error("Antigravity CLI checksum mismatch");

  const archive = new URL(manifest.url).pathname.endsWith(".tar.gz");
  const binary = archive ? join(workspace.path, "antigravity") : payload;
  if (archive) run(["tar", "-xzf", payload, "-C", workspace.path, "antigravity"]);
  if (!lstatSync(binary).isFile())
    throw new Error("Antigravity CLI payload is not a regular file");
  chmodSync(binary, 0o755);

  // The official bootstrapper runs `agy install`, which edits shell profiles
  // Install its verified payload directly, leaving PATH and aliases to dotfiles
  // A hard link publishes atomically without replacing a concurrent installation
  linkSync(binary, target);
  console.log(`Installed Antigravity CLI at ${target}`);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))
    console.log("Usage: antigravity.ts");
  else if (args.length) throw new Error("Usage: antigravity.ts");
  else installAntigravity();
}
