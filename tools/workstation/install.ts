#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { run as runCommand, shellQuote } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import type { PlatformError } from "effect";
import { Cause, Config, Console, Effect, FileSystem, Schema } from "effect";

const root = resolve(import.meta.dir, "../..");
const packageRoot = join(root, "tools/workstation");

const run = (args: string[], capture = false) =>
  runCommand(args, {
    cwd: packageRoot,
    capture,
    stderr: "inherit",
  });

// Query the compiled registry without loading its source dependencies
const commandNames = Effect.fn("workstation.commandNames")(function* (
  executable: string,
) {
  const result = yield* run([executable, "--help"], true);
  const names = result.stdout.trim().split("\n").slice(1);
  yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(names);
  if (!names.length || names.some((name) => !/^[a-z][a-z0-9-]*$/.test(name)))
    return yield* Effect.fail(
      new DotfilesError("The workstation executable returned invalid command names"),
    );
  return names;
});

const entry = Effect.fn("workstation.entry")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .lstat(path)
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(error),
      ),
    );
});

const sourceHash = Effect.fn("workstation.sourceHash")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const hash = createHash("sha256");
  const add = (path: string): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      hash.update(relative(root, path)).update("\0");
      if ((yield* fs.lstat(path)).type === "Directory") {
        for (const name of (yield* fs.readDirectory(path)).sort()) {
          if (name === "node_modules") continue;
          yield* add(join(path, name));
        }
      } else hash.update(yield* fs.readFile(path));
      hash.update("\0");
    });
  for (const name of ["src", "assets", "package.json"])
    yield* add(join(packageRoot, name));
  yield* add(join(root, "package.json"));
  yield* add(join(root, "bun.lock"));
  yield* add(join(root, "lib/typescript"));
  yield* add(join(root, "home/package.json"));
  yield* add(join(root, "home/theme/palette/palette.json"));
  yield* add(join(root, "home/generators.json"));
  yield* add(join(root, "home/deploy/schema.ts"));
  yield* add(join(root, "home/files/.local/lib/package.json"));
  yield* add(join(root, "home/files/.local/lib/typescript/process.ts"));
  hash.update(`${Bun.version}:${Bun.revision}:${process.platform}:${process.arch}`);
  return hash.digest("hex");
});

const managedLauncher = Effect.fn("workstation.managedLauncher")(function* (
  launcher: string,
  name: string,
  executable: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* entry(launcher);
  if (info?.type === "SymbolicLink")
    return resolve(dirname(launcher), yield* fs.readLink(launcher)) === executable;
  if (info?.type !== "File") return false;
  // Recognize only the exact launchers installed before multicall symlinks
  const argument = name === "workstation" ? "" : `${shellQuote(name)} `;
  return (
    (yield* fs.readFileString(launcher)) ===
    `#!/bin/sh\nexec ${shellQuote(executable)} ${argument}"$@"\n`
  );
});

const useImage = Effect.fn("workstation.useImage")(function* (
  fingerprint: string,
  bin: string,
  executable: string,
  stamp: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const imageExecutable = "/usr/bin/workstation";
  const imageStamp = "/usr/share/dotfiles/workstation.sha256";
  if (
    !(yield* fs.exists(imageExecutable)) ||
    !(yield* fs.exists(imageStamp)) ||
    (yield* fs.readFileString(imageStamp)).trim() !== fingerprint
  )
    return false;
  for (const name of ["workstation", ...(yield* commandNames(imageExecutable))]) {
    const launcher = join(bin, name);
    if (yield* managedLauncher(launcher, name, executable)) yield* fs.remove(launcher);
  }
  if (
    (yield* entry(stamp))?.type === "File" &&
    /^[a-f0-9]{64}$/.test((yield* fs.readFileString(stamp)).trim()) &&
    (yield* entry(executable))?.type === "File"
  ) {
    yield* fs.remove(executable);
    yield* fs.remove(stamp);
  }
  return true;
});

const installLaunchers = Effect.fn("workstation.installLaunchers")(function* (
  bin: string,
  executable: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const names = ["workstation", ...(yield* commandNames(executable))];
  for (const name of names) {
    const launcher = join(bin, name);
    if (
      (yield* entry(launcher)) &&
      !(yield* managedLauncher(launcher, name, executable))
    )
      return yield* Effect.fail(
        new DotfilesError(
          `Refusing to replace unmanaged workstation launcher: ${launcher}`,
        ),
      );
  }
  for (const name of names) {
    const launcher = join(bin, name);
    const info = yield* entry(launcher);
    if (info?.type === "SymbolicLink") continue;
    if (info) yield* fs.remove(launcher);
    yield* fs.symlink(executable, launcher);
  }
});

const build = Effect.fn("workstation.build")(function* (destination: string) {
  const result = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [join(packageRoot, "src/cli.ts")],
        target: "bun",
        compile: {
          outfile: destination,
          autoloadDotenv: false,
          autoloadBunfig: false,
        },
      }),
    catch: (cause) => new DotfilesError("Could not compile workstation", { cause }),
  });
  if (!result.success)
    return yield* Effect.fail(new DotfilesError(result.logs.map(String).join("\n")));
});

const install = Effect.fn("workstation.install")(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists("/etc/NIXOS")) return;
  const home = yield* Effect.sync(homedir);
  const data = join(
    yield* Config.String("XDG_DATA_HOME").pipe(
      Config.withDefault(join(home, ".local/share")),
    ),
    "dotfiles/workstation",
  );
  const bin = join(home, ".local/bin");
  yield* fs.makeDirectory(bin, { recursive: true });
  const executable = join(data, "workstation");
  const stamp = join(data, "source.sha256");
  const fingerprint = yield* sourceHash();
  if (yield* useImage(fingerprint, bin, executable, stamp)) return;
  yield* fs.makeDirectory(data, { recursive: true });
  if (
    !(yield* fs.exists(executable)) ||
    !(yield* fs.exists(stamp)) ||
    (yield* fs.readFileString(stamp)).trim() !== fingerprint
  ) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fs.makeTempDirectoryScoped({
          directory: data,
          prefix: ".build-",
        });
        const output = join(temporary, "workstation");
        yield* build(output);
        yield* run([output, "--help"], true);
        yield* fs.rename(output, executable);
        yield* fs.writeFileString(stamp, `${fingerprint}\n`);
      }),
    );
  }
  yield* installLaunchers(bin, executable);
});

if (import.meta.main) {
  runMain(
    (process.argv.slice(2).includes("--fingerprint")
      ? sourceHash().pipe(Effect.flatMap(Console.log))
      : install()
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const error = Cause.squash(cause);
        return Console.error(
          error instanceof Error ? error.message : String(error),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        );
      }),
    ),
  );
}
