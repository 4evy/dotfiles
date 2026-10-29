#!/usr/bin/env bun
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { isExecutable } from "@dotfiles/core/files";
import { runMain } from "@dotfiles/core/runtime";
import { desktopOutput, flatpakRefs } from "@dotfiles/workstation/desktop";
import { Effect, FileSystem } from "effect";

const which = Effect.fn(function* (name: string) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const path = join(directory, name);
    if (yield* isExecutable(path)) return path;
  }
  return undefined;
});

const gnome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* which("gnome-extensions"))) return;
  const installed = yield* run(["gnome-extensions", "list", "--system"], {
    capture: true,
    check: false,
  });
  if (installed.code !== 0) return;
  const wanted = [
    "focused-window-dbus@flexagoon.com",
    "hyper-window-tiling@4evy.local",
  ];
  if (!(yield* fs.exists("/etc/NIXOS")))
    wanted.push("window-calls-extended@hseliger.eu", "xremap@k0kubun.com");
  for (const extension of wanted) {
    if (!installed.stdout.trim().split("\n").includes(extension))
      return yield* Effect.fail(
        new DotfilesError(
          `Required system extension ${extension} is missing; rebuild the platform configuration`,
        ),
      );
  }
  yield* desktopOutput("configure-gnome", ...wanted);
});

const kde = Effect.gen(function* () {
  if (!process.env.XDG_CURRENT_DESKTOP?.includes("KDE")) return;
  const writer = yield* which("kwriteconfig6");
  if (writer)
    yield* run(
      [
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
      ],
      { capture: true },
    );
  const dbus = yield* which("qdbus6");
  if (dbus)
    yield* run([dbus, "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.start"], {
      capture: true,
      check: false,
    });
});

const children = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(directory))) return [];
  return (yield* fs.readDirectory(directory)).map((name) => join(directory, name));
});

const copyFontFragments = Effect.fn(function* (target: string, fragments: string[]) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(target, { recursive: true });
  let changed = false;
  for (const source of fragments) {
    const destination = join(target, basename(source));
    const original = (yield* fs.exists(destination))
      ? yield* fs.readFile(destination)
      : undefined;
    const content = yield* fs.readFile(source);
    if (
      original === undefined ||
      original.length !== content.length ||
      original.some((byte, index) => byte !== content[index])
    ) {
      yield* fs.copyFile(source, destination);
      changed = true;
    }
  }
  return changed;
});

const flatpakFonts = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = homedir();
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const fragments = (yield* children(join(config, "fontconfig/conf.d"))).filter(
    (path) => path.endsWith(".conf"),
  );
  if (!fragments.length) return;
  const apps = yield* flatpakRefs("apps");
  for (const id of new Set(apps.map((app) => app.id))) {
    const app = join(home, ".var/app", id);
    if (!(yield* fs.exists(app))) continue;
    if ((yield* fs.stat(app)).type !== "Directory") continue;
    if (!(yield* copyFontFragments(join(app, "config/fontconfig/conf.d"), fragments)))
      continue;
    for (const cache of yield* children(join(app, "cache/fontconfig"))) {
      const entry = yield* fs.lstat(cache).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      );
      if (
        basename(cache).includes("cache-") &&
        (entry?.type === "File" || entry?.type === "SymbolicLink")
      )
        yield* fs.remove(cache, { force: true });
    }
  }
});

if (import.meta.main && process.platform === "linux") {
  runMain(
    Effect.gen(function* () {
      yield* gnome;
      yield* kde;
      yield* flatpakFonts;
    }),
  );
}
