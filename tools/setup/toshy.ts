#!/usr/bin/env bun
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, type PlatformError } from "effect";

const root = resolve(import.meta.dir, "../..");

const sliceMarker =
  /^(?<start>### {2}SLICE_MARK_START: (?<name>\w+) {2}###[^\n]*\n)(?<body>.*?)(?<end>^### {2}SLICE_MARK_END: \k<name> {2}###[^\n]*$)/gms;

const setupBootstrap = `
import builtins
import pathlib
import runpy
import sys


def automated_input(prompt: object = "") -> str:
    text = str(prompt)
    folded = text.casefold()
    answer = "YES" if "barebones" in folded and 'enter "yes" to proceed' in folded else ""
    print(text + answer, flush=True)
    return answer


source = pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0, str(source.parent))
builtins.input = automated_input
sys.argv = [str(source), "install-user-files", "--barebones-config"]
runpy.run_path(str(source), run_name="__main__")
`;

const statIfExists = Effect.fn(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(path).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );
});

export const readSlices = Effect.fn(function* (sliceDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = (yield* fs.readDirectory(sliceDir))
    .filter((entry) => entry.endsWith(".py"))
    .sort();
  if (entries.length === 0)
    return yield* Effect.fail(
      new DotfilesError(`No Toshy slice files found in ${sliceDir}`),
    );
  const slices: Record<string, string> = {};
  for (const entry of entries) {
    const content = yield* fs.readFileString(join(sliceDir, entry));
    slices[basename(entry, ".py")] = `${content.trim()}\n`;
  }
  return slices;
});

export function extractSlices(config: string): Record<string, string> {
  const slices: Record<string, string> = {};
  for (const match of config.matchAll(sliceMarker)) {
    const name = match.groups?.name;
    const body = match.groups?.body;
    if (name !== undefined && body !== undefined) slices[name] = `${body.trim()}\n`;
  }
  return slices;
}

export const mergeSlices = Effect.fn(function* (
  config: string,
  slices: Readonly<Record<string, string>>,
  options: {
    upstreamConfig?: string;
    resetSlices?: readonly string[];
  } = {},
) {
  const replacements: Record<string, string> = { ...slices };
  const resetSlices = options.resetSlices ?? [];
  if (resetSlices.length > 0) {
    if (options.upstreamConfig === undefined)
      return yield* Effect.fail(
        new DotfilesError("--reset-slice requires --upstream-config"),
      );
    const upstreamSlices = extractSlices(options.upstreamConfig);
    for (const name of resetSlices) {
      if (Object.hasOwn(replacements, name))
        return yield* Effect.fail(
          new DotfilesError(`Slice ${name} cannot be both reset and dotfiles-managed`),
        );
      const upstreamSlice = upstreamSlices[name];
      if (upstreamSlice === undefined)
        return yield* Effect.fail(
          new DotfilesError(`Upstream config is missing Toshy slice: ${name}`),
        );
      replacements[name] = upstreamSlice;
    }
  }

  const found = new Set<string>();
  const merged = config.replace(
    sliceMarker,
    (match, start: string, name: string, _body: string, end: string) => {
      const replacement = replacements[name];
      if (replacement === undefined) return match;
      found.add(name);
      return `${start}\n${replacement}\n${end}`;
    },
  );
  const missing = Object.keys(replacements)
    .filter((name) => !found.has(name))
    .sort();
  if (missing.length > 0)
    return yield* Effect.fail(
      new DotfilesError(
        `Config is missing Toshy slice marker(s): ${missing.join(", ")}`,
      ),
    );
  return merged;
});

function installNeeded(options: {
  forceInstall: boolean;
  configExists: boolean;
  installedRevision: string | undefined;
  revision: string;
}): boolean {
  return (
    options.forceInstall ||
    !options.configExists ||
    options.installedRevision !== options.revision
  );
}

function hiddenDesktopEntry(text: string): string {
  if (text.includes("NoDisplay=true")) return text;
  return text.replaceAll("[Desktop Entry]", "[Desktop Entry]\nNoDisplay=true");
}

const copyMutableTree: (
  source: string,
  destination: string,
) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =
  Effect.fn(function* (source: string, destination: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(destination, { mode: 0o755 });
    for (const name of yield* fs.readDirectory(source)) {
      const entry = join(source, name);
      const target = join(destination, name);
      const info = yield* fs.lstat(entry);
      if (info.type === "SymbolicLink") {
        yield* fs.symlink(yield* fs.readLink(entry), target);
      } else if (info.type === "Directory") {
        yield* copyMutableTree(entry, target);
      } else {
        yield* fs.copyFile(entry, target);
        yield* fs.chmod(target, (info.mode & 0o7777) | 0o200);
      }
    }
  });

const provisionUserFiles = Effect.fn(function* (
  source: string,
  runtime: string,
  env: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "toshy." });
      const checkout = join(temporary, "source");
      yield* copyMutableTree(source, checkout);
      yield* run(
        [
          join(runtime, "bin/python"),
          "-c",
          setupBootstrap,
          join(checkout, "setup_toshy.py"),
        ],
        { cwd: checkout, env },
      );
    }),
  );
});

const configurationUpdate = Effect.fn(function* (options: {
  current: Uint8Array;
  slices: Readonly<Record<string, string>>;
  upstreamConfig: string;
  filename: string;
  python: string;
}) {
  const text = Buffer.from(options.current)
    .toString("utf-8")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const merged = yield* mergeSlices(text, options.slices, {
    upstreamConfig: options.upstreamConfig,
    resetSlices: ["keymapper_api"],
  });
  yield* run(
    [
      options.python,
      "-c",
      "import sys; compile(sys.stdin.buffer.read(), sys.argv[1], 'exec')",
      options.filename,
    ],
    { input: merged },
  );
  const encoded = Buffer.from(merged, "utf-8");
  return {
    encoded,
    restartNeeded: Buffer.compare(Buffer.from(options.current), encoded) !== 0,
  };
});

const hideDesktopSurfaces = Effect.fn(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const directory of [
    join(home, ".local/share/applications"),
    join(home, ".config/autostart"),
  ]) {
    for (const name of ["Toshy_Tray.desktop", "app.toshy.preferences.desktop"]) {
      const path = join(directory, name);
      const info = yield* statIfExists(path);
      if (info?.type !== "File") continue;
      const text = yield* fs.readFileString(path);
      const hidden = hiddenDesktopEntry(text);
      if (hidden !== text) yield* fs.writeFileString(path, hidden);
    }
  }
});

export const provisionToshy = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = homedir();
  const state = join(process.env.XDG_STATE_HOME || join(home, ".local/state"), "toshy");
  yield* fs.makeDirectory(state, { recursive: true });
  const runtime = join(state, "runtime");
  if (!(yield* fs.exists("/etc/NIXOS")))
    yield* run(["nix", "build", ".#toshy-runtime", "--out-link", runtime], {
      cwd: root,
    });
  if ((yield* statIfExists(runtime))?.type !== "Directory")
    return yield* Effect.fail(
      new DotfilesError("Rebuild NixOS before provisioning Toshy's user files"),
    );

  const source = join(runtime, "share/toshy/source");
  const revision = (yield* fs.readFileString(
    join(runtime, "share/toshy/revision"),
  )).trim();
  const configDir = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "toshy");
  const config = join(configDir, "toshy_config.py");
  const stamp = join(state, "installed-revision");
  const env: NodeJS.ProcessEnv = { ...process.env, TOSHY_RUNTIME_DIR: runtime };

  const configExists = (yield* statIfExists(config))?.type === "File";
  const installedRevision =
    (yield* statIfExists(stamp))?.type === "File"
      ? (yield* fs.readFileString(stamp)).trim()
      : undefined;
  if (
    installNeeded({
      forceInstall: process.env.TOSHY_RUN_INSTALLER === "1",
      configExists,
      installedRevision,
      revision,
    })
  ) {
    yield* provisionUserFiles(source, runtime, env);
    yield* fs.writeFileString(stamp, `${revision}\n`);
  }

  yield* run(["systemctl", "--user", "daemon-reload"]);
  const { encoded, restartNeeded } = yield* configurationUpdate({
    current: yield* fs.readFile(config),
    slices: yield* readSlices(join(root, "packages/toshy/user/slices")),
    upstreamConfig: yield* fs.readFileString(
      join(source, "default-toshy-config/toshy_config_barebones.py"),
    ),
    filename: config,
    python: join(runtime, "bin/python"),
  });
  if (restartNeeded) {
    yield* fs.writeFile(config, encoded);
    yield* run(["systemctl", "--user", "restart", "toshy-config.service"]);
  }
  yield* run(["systemctl", "--user", "disable", "--now", "toshy-tray.service"], {
    check: false,
    stderr: "ignore",
  });
  // Arming the path watcher is enough: running its oneshot here restarts a
  // healthy remapper on every apply, discarding any keys currently held
  yield* run([
    "systemctl",
    "--user",
    "start",
    "toshy-config.service",
    "toshy-kanata-device.path",
  ]);
  yield* hideDesktopSurfaces(home);
  yield* run(["systemctl", "is-active", "--quiet", "kanata-main.service"]);
  yield* run(["systemctl", "--user", "is-active", "--quiet", "toshy-config.service"]);

  const device = "/run/kanata-main/main";
  const deviceInfo = yield* fs.lstat(device).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );
  if (
    deviceInfo?.type !== "SymbolicLink" ||
    !(yield* fs.readLink(device)).startsWith("/dev/input/event")
  )
    return yield* Effect.fail(
      new DotfilesError("Kanata has not published its virtual input device"),
    );
});

if (import.meta.main) {
  runMain(
    Effect.gen(function* () {
      const args = Bun.argv.slice(2);
      if (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))
        yield* Effect.sync(() => console.log("Usage: toshy.ts"));
      else if (args.length)
        return yield* Effect.fail(new DotfilesError("Usage: toshy.ts"));
      else yield* provisionToshy();
    }),
  );
}
