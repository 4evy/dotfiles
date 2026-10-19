#!/usr/bin/env bun
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { run as runCommand } from "../../lib/typescript/commands.ts";
import {
  desktopOutput,
  flatpakRefs,
} from "../../packages/workstation/src/linux/desktop.ts";

function run(args: string[], check = true): { code: number; stdout: string } {
  const result = runCommand(args, { capture: true, check });
  return { code: result.code, stdout: result.stdout.trim() };
}

function gnome(): void {
  if (!Bun.which("gnome-extensions")) return;
  const installed = run(["gnome-extensions", "list", "--system"], false);
  if (installed.code !== 0) return;
  const wanted = [
    "focused-window-dbus@flexagoon.com",
    "hyper-window-tiling@4evy.local",
  ];
  if (!existsSync("/etc/NIXOS"))
    wanted.push("window-calls-extended@hseliger.eu", "xremap@k0kubun.com");
  for (const extension of wanted) {
    if (!installed.stdout.split("\n").includes(extension))
      throw new Error(
        `Required system extension ${extension} is missing; rebuild the platform configuration`,
      );
  }
  desktopOutput("configure-gnome", ...wanted);
}

function kde(): void {
  if (!process.env.XDG_CURRENT_DESKTOP?.includes("KDE")) return;
  const writer = Bun.which("kwriteconfig6");
  if (writer)
    run([
      writer,
      "--file",
      "kwinrc",
      "--group",
      "Plugins",
      "--key",
      "hyper-window-tilingEnabled",
      "--type",
      "bool",
      "true",
    ]);
  const dbus = Bun.which("qdbus6");
  if (dbus)
    run([dbus, "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.start"], false);
}

function children(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).map((name) => join(directory, name));
}

function copyFontFragments(target: string, fragments: string[]): boolean {
  mkdirSync(target, { recursive: true });
  let changed = false;
  for (const source of fragments) {
    const destination = join(target, basename(source));
    if (
      !existsSync(destination) ||
      !readFileSync(destination).equals(readFileSync(source))
    ) {
      copyFileSync(source, destination);
      changed = true;
    }
  }
  return changed;
}

function flatpakFonts(): void {
  const home = homedir();
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const fragments = children(join(config, "fontconfig/conf.d")).filter((path) =>
    path.endsWith(".conf"),
  );
  if (!fragments.length) return;
  const apps = flatpakRefs("apps");
  for (const id of new Set(apps.map((app) => app.id))) {
    const app = join(home, ".var/app", id);
    if (!existsSync(app)) continue;
    if (!statSync(app).isDirectory()) continue;
    if (!copyFontFragments(join(app, "config/fontconfig/conf.d"), fragments)) continue;
    for (const cache of children(join(app, "cache/fontconfig"))) {
      if (basename(cache).includes("cache-") && statSync(cache).isFile()) rmSync(cache);
    }
  }
}

if (import.meta.main && process.platform === "linux") {
  gnome();
  kde();
  flatpakFonts();
}
