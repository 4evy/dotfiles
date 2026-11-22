#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { object } from "@optique/core/constructs";
import { runParser } from "@optique/core/facade";
import { optional, withDefault } from "@optique/core/modifiers";
import { argument, flag, option } from "@optique/core/primitives";
import { choice, string } from "@optique/core/valueparser";
import { Effect, FileSystem } from "effect";

const ROOT = process.env.DOTFILES_REPO ?? resolve(import.meta.dir, "../..");
const MACOS = process.platform === "darwin";

export const darwinBundleCommand = (uid: string, user: string, bundle: string[]) => [
  "/bin/launchctl",
  "asuser",
  uid,
  "/usr/bin/sudo",
  "--preserve-env=PATH,SUDO_ASKPASS,DOTFILES_SUDO_PASSWORD",
  "-H",
  "-u",
  user,
  "--",
  ...bundle,
];

const updateSandbox = Effect.fn(function* (
  prefix: string,
  before: string,
  after: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(prefix, "Library/Homebrew/extend/os/mac/sandbox.rb");
  if (!(yield* fs.exists(path))) return;
  const source = yield* fs.readFileString(path);
  const updated = source.replaceAll(before, after);
  if (source !== updated) yield* fs.writeFileString(path, updated);
});

const deniedRule = "        (deny mach-lookup)\n";

const bundle = Effect.fn(function* (prefix: string, file: string, upgrade: boolean) {
  const brew = join(prefix, "bin/brew");
  const env = {
    ...process.env,
    PATH: [
      join(prefix, "bin"),
      join(prefix, "sbin"),
      join(homedir(), ".local/bin"),
      process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    ].join(":"),
    HOMEBREW_NO_AUTO_UPDATE: "1",
  };
  const command = (args: string[]) =>
    run(
      MACOS
        ? [
            "/usr/bin/env",
            "-u",
            "SUDO_USER",
            "-u",
            "HOMEBREW_SUDO_USER",
            "-u",
            "SSH_TTY",
            "-u",
            "HOMEBREW_SSH_TTY",
            brew,
            ...args,
          ]
        : [brew, ...args],
      { env, stdin: "ignore" },
    );

  // Update Brew itself before editing its source, never while the rule is patched
  if (upgrade) yield* command(["update"]);
  // Mark only our temporary rules so cleanup preserves existing allows and updates
  const temporaryRule = "        (allow mach-lookup) ; dotfiles bundle\n";
  yield* Effect.scoped(
    Effect.gen(function* () {
      if (MACOS) {
        yield* Effect.addFinalizer(() =>
          updateSandbox(prefix, temporaryRule, deniedRule).pipe(Effect.orDie),
        );
        yield* updateSandbox(prefix, deniedRule, temporaryRule);
      }
      // Keep extension installers from changing the caller's terminal input
      yield* command([
        "bundle",
        "install",
        upgrade ? "--upgrade" : "--no-upgrade",
        "--file",
        file,
      ]);
    }),
  );
});

if (import.meta.main) {
  const values = runParser(
    object({
      operation: argument(choice(["bundle"])),
      prefix: withDefault(
        option("--prefix", string({ metavar: "PATH" })),
        MACOS ? "/opt/homebrew" : "/home/linuxbrew/.linuxbrew",
      ),
      file: withDefault(
        option("--file", string({ metavar: "PATH" })),
        join(ROOT, "Brewfile"),
      ),
      user: optional(option("--user", string({ metavar: "USER" }))),
      upgrade: withDefault(flag("--upgrade"), false),
    }),
    "homebrew.ts",
    Bun.argv.slice(2),
    {
      help: { option: { names: ["-h", "--help"] }, onShow: process.exit },
      onError: process.exit,
    },
  );
  runMain(
    Effect.gen(function* () {
      const { prefix, file, upgrade, user } = values;
      if (!user) {
        yield* bundle(prefix, file, upgrade);
        return;
      }
      if (!MACOS || process.getuid?.() !== 0)
        return yield* Effect.fail(new DotfilesError("--user requires root on macOS"));
      const { stdout } = yield* run(["/usr/bin/id", "-u", "--", user], {
        capture: true,
      });
      yield* run(
        darwinBundleCommand(stdout.trim(), user, [
          process.execPath,
          import.meta.path,
          "bundle",
          "--prefix",
          prefix,
          "--file",
          resolve(file),
          ...(upgrade ? ["--upgrade"] : []),
        ]),
        { stdin: "ignore" },
      );
    }),
  );
}
