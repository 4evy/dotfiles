#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildHjemOutput } from "../hjem/nix.ts";
import { validateXML } from "./xml.ts";

const repository = resolve(import.meta.dir, "../..");
const platforms = ["darwin", "fedora", "nixos"];
const platform = Bun.argv[2];
if (!platform || !platforms.includes(platform) || Bun.argv.length !== 3)
  throw new Error(`Usage: bun scripts/check/hjem.ts ${platforms.join("|")}`);
const temporary = mkdtempSync(join(tmpdir(), `hjem-check-${platform}-`));

function run(command: string[], cwd = repository): void {
  const result = Bun.spawnSync(command, {
    cwd,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0)
    throw new Error(`${command[0]} exited with status ${result.exitCode}`);
}

try {
  const output = await buildHjemOutput(repository, "hjemHome", {
    ...process.env,
    HJEM_WORKING_TREE: repository,
    HJEM_PLATFORM: platform === "darwin" ? "darwin" : "linux",
    HJEM_OS_RELEASE_ID: platform === "darwin" ? "" : platform,
  });
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  const hooks = JSON.parse(readFileSync(join(output, "hooks.json"), "utf8"));
  const paths: string[] = [
    ...manifest.files
      .map((entry: { source: string }) => entry.source)
      .filter(
        (path: string) =>
          /^[a-z0-9]{32}-hjem-/.test(basename(path)) &&
          statSync(path, { throwIfNoEntry: false })?.isFile(),
      ),
    ...hooks.map((entry: { source: string }) => entry.source),
  ];
  let checked = 0;
  for (const path of paths) {
    const target = path;
    const contents = readFileSync(path, "utf8");
    if (!contents.trim()) continue;
    try {
      if (path.endsWith(".json")) JSON.parse(contents);
      else if (path.endsWith(".toml")) Bun.TOML.parse(contents);
      else if (/\.(?:plist|xml|tmTheme)$/.test(path)) validateXML(contents);
      else if (/\.(?:[cm]?[jt]s)$/.test(path))
        new Bun.Transpiler({ loader: path.endsWith("ts") ? "ts" : "js" }).transformSync(
          contents,
        );
      else if (/\.(?:zsh|zshenv|zshrc)$/.test(path)) run(["zsh", "-n", path]);
      else if (
        /\.(?:bash|sh|bashenv|bashrc|bash_profile|zprofile)$/.test(path) ||
        /^#!.*\/(?:ba)?sh\b/.test(contents)
      )
        run(["bash", "-n", path]);
      checked++;
    } catch (error) {
      throw new Error(`Generated Hjem target: ${target} (${platform})`, {
        cause: error,
      });
    }
  }
  console.log(`${platform}: checked ${checked} generated home files and hooks`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
