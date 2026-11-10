#!/usr/bin/env bun
import { join } from "node:path";
import { run } from "@dotfiles/core/commands";
import { runMain } from "@dotfiles/core/runtime";
import caches from "@dotfiles/repo/data/nix/caches";
import { Effect, FileSystem } from "effect";

const configuration = "/etc/nix/nix.custom.conf";
const ownedHeaders = [
  "# Managed by the dotfiles Ansible tools role.",
  "# Spectrum overrides for the installer-managed Determinate Nix daemon",
];

runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (process.platform !== "linux" || (yield* fs.exists("/etc/NIXOS"))) return;
    if (!(yield* fs.exists(configuration))) return;
    const current = yield* fs.readFileString(configuration);
    if (!ownedHeaders.some((header) => current.startsWith(`${header}\n`))) return;
    const selected = caches.filter(
      (cache) => !cache.platforms || cache.platforms.includes("spectrum"),
    );
    const settings: Record<string, string> = {
      "extra-substituters": selected.map((cache) => cache.url).join(" "),
      "extra-trusted-public-keys": selected.map((cache) => cache.key).join(" "),
    };
    const lines: string[] = [];
    for (const line of current.trimEnd().split("\n")) {
      const key = line.match(/^\s*([^#\s=]+)\s*=/)?.[1];
      if (!key || !Object.hasOwn(settings, key)) lines.push(line);
    }
    for (const [key, value] of Object.entries(settings))
      lines.push(`${key} = ${value}`);
    const updated = `${lines.join("\n")}\n`;
    if (updated === current) return;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-nix-" });
    const source = join(temporary, "nix.custom.conf");
    yield* fs.writeFileString(source, updated, { mode: 0o600 });
    yield* run([
      "sudo",
      "install",
      "-m",
      "0644",
      "-o",
      "root",
      "-g",
      "root",
      source,
      configuration,
    ]);
    yield* run(["sudo", "systemctl", "restart", "nix-daemon.service"]);
    console.log("Updated dotfiles-owned Nix binary caches");
  }),
);
