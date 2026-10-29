#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type RunOptions, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { isExecutable } from "@dotfiles/core/files";
import { download } from "@dotfiles/core/http";
import { type RuntimeServices, runMain } from "@dotfiles/core/runtime";
import homebrewTools from "@dotfiles/repo/data/homebrew/tools";
import {
  Effect,
  FileSystem,
  type PlatformError,
  Schedule,
  type Scope,
  Terminal,
} from "effect";
import type { HttpClientError } from "effect/http";

// setup.sh prepares the frozen workspace dependencies before importing this file
const root = resolve(import.meta.dir, "../..");
const minimumMacOSMajor = 27;
const homebrewRevision = "85d1a3fc80d8a63932f632aca8f787de11d14a64";
const homebrewURL = `https://raw.githubusercontent.com/Homebrew/install/${homebrewRevision}/install.sh`;
const homebrewSHA256 =
  "5f333bbe53bc490e51e7ccb1df8779b3dd6ee73a1a7379efda216edb08ccb148";

const log = (message: string) => Effect.sync(() => console.log(`\n==> ${message}`));

const workstation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const nixos = process.platform === "linux" && (yield* fs.exists("/etc/NIXOS"));
  const userBin = join(homedir(), ".local/bin");
  let brewPrefix: string;
  if (process.platform === "darwin") {
    if (process.arch !== "arm64")
      return yield* Effect.fail(
        new DotfilesError("Use a native Apple Silicon terminal, not Rosetta"),
      );
    brewPrefix = "/opt/homebrew";
  } else if (process.platform === "linux") {
    if (!nixos && !(yield* fs.exists("/usr/bin/bootc")))
      return yield* Effect.fail(
        new DotfilesError("Linux workstation setup supports only BlueBuild and NixOS"),
      );
    brewPrefix = "/home/linuxbrew/.linuxbrew";
  } else
    return yield* Effect.fail(
      new DotfilesError(`Unsupported platform: ${process.platform}`),
    );
  const paths: string[] = [];
  if (process.platform === "linux" && !nixos)
    paths.push(
      join(
        process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
        "hjem/standalone/current-profile/bin",
      ),
    );
  paths.push(nixos ? "/run/current-system/sw/bin" : userBin);
  if (!nixos) {
    if (process.platform === "darwin")
      paths.push(
        ...homebrewTools
          .filter((tool) => tool.bootstrap)
          .map((tool) => join(brewPrefix, "opt", tool.formula, tool.path)),
      );
    paths.push(
      join(brewPrefix, "bin"),
      join(brewPrefix, "sbin"),
      "/nix/var/nix/profiles/default/bin",
      join(homedir(), ".nix-profile/bin"),
    );
  }
  let env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [...paths, process.env.PATH ?? "/usr/bin:/bin"].join(delimiter),
    UV_TOOL_BIN_DIR: userBin,
  };
  let sudoReady = false;

  const command = (args: string[], options: RunOptions & { quiet?: boolean } = {}) =>
    run(args, {
      cwd: root,
      env,
      stdin: "inherit",
      ...options,
      check: false,
      ...(options.quiet ? { outputMode: "discard", stderr: "ignore" } : {}),
    }).pipe(
      Effect.flatMap((result) =>
        options.check !== false && result.code !== 0
          ? Effect.fail(
              new DotfilesError(`${args[0]} exited with status ${result.code}`),
            )
          : Effect.succeed(result),
      ),
    );
  const output = (args: string[]) =>
    command(args, { capture: true, stderr: "inherit" }).pipe(
      Effect.map((result) => result.stdout.trim()),
    );
  const succeeds = (args: string[], input?: string) =>
    command(args, {
      quiet: true,
      check: false,
      ...(input === undefined ? {} : { input }),
    }).pipe(Effect.map((result) => result.code === 0));
  const which = Effect.fn(function* (name: string) {
    for (const directory of (env.PATH ?? "").split(delimiter)) {
      const path = join(directory, name);
      if (yield* isExecutable(path)) return path;
    }
    return undefined;
  });

  const promptPassword = Effect.gen(function* () {
    const terminalState = yield* output(["stty", "-g"]);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(command(["stty", "-echo"]), () =>
          command(["stty", terminalState], { outputMode: "discard" }).pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.sync(() => {
                process.stderr.write("\n");
              }),
            ),
          ),
        );
        const terminal = yield* Terminal.Terminal;
        yield* Effect.sync(() => {
          process.stderr.write(`[sudo] password for ${userInfo().username}: `);
        });
        return yield* terminal.readLine.pipe(
          Effect.mapError(() => new DotfilesError("Sudo password input closed")),
        );
      }),
    );
  });

  const password = Effect.gen(function* () {
    if (!(yield* which("sudo")))
      return yield* Effect.fail(new DotfilesError("Privileged tasks require sudo"));
    const validate = (value: string) =>
      succeeds(["sudo", "-S", "-k", "-p", "", "-v"], `${value}\n`);
    let value = env.DOTFILES_SUDO_PASSWORD;
    if (value !== undefined && (yield* validate(value))) return value;
    value = yield* fs.readFileString("/etc/bleh").pipe(
      Effect.map((content) => content.replace(/\n+$/, "")),
      Effect.orElseSucceed(() => undefined),
    );
    if (value !== undefined && (yield* validate(value))) return value;
    if (!process.stdin.isTTY)
      return yield* Effect.fail(
        new DotfilesError("Sudo authentication is required; run interactively"),
      );
    for (let attempt = 0; attempt < 3; attempt++) {
      value = yield* promptPassword;
      if (yield* validate(value)) return value;
      yield* Effect.sync(() => console.error("Sorry, try again"));
    }
    return yield* Effect.fail(new DotfilesError("Failed to validate sudo credentials"));
  });

  const ensureSudo = Effect.gen(function* () {
    if (sudoReady) return;
    if (!env.SUDO_ASKPASS || !(yield* succeeds(["sudo", "-n", "-k", "-v"]))) {
      const credential = yield* password;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-sudo." });
      const helper = join(directory, "askpass");
      yield* fs.writeFileString(
        helper,
        `#!/bin/sh\nprintf "%s\\n" "\${DOTFILES_SUDO_PASSWORD:?}"\n`,
        { mode: 0o700 },
      );
      const sudo = env.DOTFILES_REAL_SUDO ?? (yield* which("sudo"));
      if (!sudo)
        return yield* Effect.fail(new DotfilesError("Privileged tasks require sudo"));
      // Both sudo calls share the wrapper's parent-PID authentication ticket
      yield* fs.writeFileString(
        join(directory, "sudo"),
        '#!/bin/sh\n"$DOTFILES_REAL_SUDO" -A -v || exit "$?"\n"$DOTFILES_REAL_SUDO" "$@"\nexit "$?"\n',
        { mode: 0o700 },
      );
      env = {
        ...env,
        DOTFILES_SUDO_PASSWORD: credential,
        DOTFILES_REAL_SUDO: sudo,
        SUDO_ASKPASS: helper,
        PATH: `${directory}${delimiter}${env.PATH}`,
      };
      yield* command([sudo, "-A", "-v"], { quiet: true });
      // A scoped fiber serializes refreshes and stops before removing the helpers
      yield* Effect.gen(function* () {
        yield* Effect.sleep("45 seconds");
        yield* command([sudo, "-A", "-v"], { quiet: true, check: false }).pipe(
          Effect.ignore,
        );
      }).pipe(Effect.forever, Effect.forkScoped);
    }
    sudoReady = true;
  });

  const ensureHomebrew = Effect.gen(function* () {
    const brew = join(brewPrefix, "bin/brew");
    if (yield* isExecutable(brew)) return;
    yield* ensureSudo;
    if (process.platform === "linux") {
      yield* log("Activating image-provisioned Homebrew");
      yield* command(["sudo", "systemctl", "start", "brew-setup.service"]);
    } else {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* fs.makeTempDirectoryScoped({
            prefix: "dotfiles-bootstrap.",
          });
          const installer = join(temporary, "homebrew-install.sh");
          const url = env.HOMEBREW_INSTALLER_URL ?? homebrewURL;
          const checksum = (env.HOMEBREW_INSTALLER_CHECKSUM ?? homebrewSHA256)
            .replace(/^sha256:/, "")
            .toLowerCase();
          if (!/^[0-9a-f]{64}$/.test(checksum))
            return yield* Effect.fail(
              new DotfilesError("Homebrew installer requires a valid SHA-256 checksum"),
            );
          yield* log("Downloading the Homebrew installer");
          const content = yield* download(url, (response) => response.arrayBuffer).pipe(
            Effect.retry({ times: 3, schedule: Schedule.spaced("1 second") }),
            Effect.map((buffer) => new Uint8Array(buffer)),
          );
          if (createHash("sha256").update(content).digest("hex") !== checksum)
            return yield* Effect.fail(
              new DotfilesError("Homebrew installer checksum mismatch"),
            );
          yield* fs.writeFile(installer, content);
          yield* log(`Installing Homebrew into ${brewPrefix}`);
          yield* command(["bash", installer], { env: { ...env, NONINTERACTIVE: "1" } });
        }),
      );
    }
    if (!(yield* isExecutable(brew)))
      return yield* Effect.fail(new DotfilesError(`Homebrew did not create ${brew}`));
  });

  const prepareHomebrew = () =>
    Effect.gen(function* () {
      if (process.platform === "darwin") {
        const version = yield* output(["sw_vers", "-productVersion"]);
        if (Number(version.split(".")[0]) < minimumMacOSMajor)
          return yield* Effect.fail(
            new DotfilesError(
              `macOS ${minimumMacOSMajor}+ is required; found ${version}`,
            ),
          );
      }
      yield* ensureHomebrew;
      if ((yield* output([join(brewPrefix, "bin/brew"), "--prefix"])) !== brewPrefix)
        return yield* Effect.fail(
          new DotfilesError("Homebrew reported an unexpected prefix"),
        );
    });

  const installUv = () =>
    Effect.gen(function* () {
      if (!(yield* isExecutable(join(brewPrefix, "bin/uv"))))
        yield* command([join(brewPrefix, "bin/brew"), "install", "--formula", "uv"], {
          env: { ...env, HOMEBREW_NO_ASK: "1" },
        });
    });

  const installUserland = () =>
    Effect.gen(function* () {
      if (nixos) return;
      yield* ensureSudo;
      yield* command([
        process.execPath,
        join(root, "tools/setup/homebrew.ts"),
        "bundle",
        ...(env.DOTFILES_HOMEBREW_UPGRADE === "1" ? ["--upgrade"] : []),
      ]);
      yield* command([
        join(brewPrefix, "bin/rustup"),
        "toolchain",
        "install",
        "stable",
        "--profile",
        "default",
        "--component",
        "rustfmt",
        "--component",
        "clippy",
        "--component",
        "rust-analyzer",
        "--component",
        "rust-src",
      ]);
    });

  const installNix = () =>
    Effect.gen(function* () {
      if (nixos) return;
      yield* ensureSudo;
      if (!(yield* isExecutable(join(brewPrefix, "bin/just"))))
        yield* command([join(brewPrefix, "bin/brew"), "install", "just", "jq"]);
      yield* command([join(brewPrefix, "bin/just"), "nix", "_ensure"]);
      if (process.platform === "linux")
        yield* command([join(brewPrefix, "bin/just"), "nix"]);
    });

  const configureBootc = Effect.gen(function* () {
    yield* ensureSudo;
    const farstep = yield* output([
      "nix",
      "build",
      `${root}#farstep`,
      "--no-link",
      "--print-out-paths",
    ]);
    const nixEnv = yield* which("nix-env");
    if (!nixEnv) return yield* Effect.fail(new DotfilesError("Nix is missing nix-env"));
    const profile = "/nix/var/nix/profiles/dotfiles-farstep";
    yield* command(["sudo", nixEnv, "--profile", profile, "--set", farstep]);
    yield* command([
      "sudo",
      "ln",
      "--symbolic",
      "--force",
      "--no-dereference",
      `${profile}/bin/farstep-desktop`,
      "/usr/local/bin/farstep-desktop",
    ]);
    const user = userInfo().username;
    yield* Effect.forEach(["input", "uinput"], (group) =>
      command(["sudo", "usermod", "--append", "--groups", group, user]),
    );
    yield* command(["sudo", "usermod", "--shell", "/bin/zsh", user]);
    yield* command(["sudo", "modprobe", "uinput"]);
    if (
      env.DOTFILES_KEEP_INPUT_REMAPPER !== "1" &&
      (yield* succeeds(["systemctl", "cat", "input-remapper.service"]))
    )
      yield* command(["sudo", "systemctl", "mask", "--now", "input-remapper.service"]);
    yield* command(["sudo", "systemctl", "start", "kanata-main.service"]);
  });

  const configureHost = () =>
    Effect.gen(function* () {
      if (process.platform === "darwin") {
        yield* ensureSudo;
        const darwinSource = yield* output([
          "nix",
          "eval",
          "--impure",
          "--raw",
          "--expr",
          "(import ./flake.nix).inputs.darwin.url",
        ]);
        // Refresh local working trees after edits change their recorded NAR hash
        if (darwinSource.startsWith("git+file:") || darwinSource.startsWith("path:"))
          yield* command(["nix", "flake", "update", "darwin", "--allow-dirty-locks"]);
        const system = yield* output([
          "nix",
          "build",
          ".#darwin.configurations.evy.system",
          "--no-link",
          "--print-out-paths",
        ]);
        yield* command([
          "sudo",
          "--preserve-env=DOTFILES_SUDO_PASSWORD,SUDO_ASKPASS",
          join(system, "activate"),
          "--profile",
          "/nix/var/nix/profiles/system",
        ]);
      } else {
        if (!nixos) yield* configureBootc;
        yield* command([process.execPath, join(root, "tools/setup/toshy.ts")]);
      }
    });

  return {
    nixos,
    prepareHomebrew,
    installUv,
    installUserland,
    installNix,
    configureHost,
    installWorkstation: () =>
      command(["sh", join(root, "tools/workstation/install.sh")], {
        env: { ...env, BUN_EXE: process.execPath },
      }),
    installAntigravity: () =>
      command([process.execPath, join(root, "tools/setup/antigravity.ts")]),
    applyDotfiles: () => command(["just", "apply"]),
  };
});

type Workstation = Effect.Success<typeof workstation>;

type Step = {
  name: string;
  description: string;
  action: (
    host: Workstation,
  ) => Effect.Effect<
    unknown,
    DotfilesError | PlatformError.PlatformError | HttpClientError.HttpClientError,
    RuntimeServices | Scope.Scope
  >;
  nixos?: boolean;
};
const bootstrapSteps: Step[] = [
  {
    name: "homebrew",
    description: "Prepare Homebrew",
    action: (host) => host.prepareHomebrew(),
  },
  { name: "uv", description: "Install uv", action: (host) => host.installUv() },
];
const setupSteps: Step[] = [
  ...bootstrapSteps,
  { name: "nix", description: "Prepare Nix", action: (host) => host.installNix() },
  {
    name: "userland",
    description: "Install Homebrew tools and Rust",
    action: (host) => host.installUserland(),
  },
  {
    name: "workstation",
    description: "Install the Bun workstation commands",
    action: (host) => host.installWorkstation(),
  },
  {
    name: "antigravity",
    description: "Install Antigravity App and CLI",
    action: (host) => host.installAntigravity(),
  },
  {
    name: "host",
    description: "Configure platform services",
    action: (host) => host.configureHost(),
    nixos: true,
  },
  {
    name: "dotfiles",
    description: "Apply Hjem dotfiles",
    action: (host) => host.applyDotfiles(),
    nixos: true,
  },
];

const commands: Record<string, Step[]> = {
  bootstrap: bootstrapSteps,
  setup: setupSteps,
};
const usage = "Usage: setup.ts bootstrap|setup [--only STEP...] [--from STEP] [--plan]";

function options(args: string[]): { steps: Step[]; plan: boolean } {
  const [command, ...flags] = args;
  const all =
    command !== undefined && Object.hasOwn(commands, command)
      ? commands[command]
      : undefined;
  if (!all) throw new Error(usage);
  const { values, tokens } = parseArgs({
    args: flags,
    allowPositionals: true,
    tokens: true,
    options: {
      plan: { type: "boolean", default: false },
      from: { type: "string" },
      only: { type: "string", multiple: true },
    },
  });
  // Only --only consumes following positional step names, until the next option
  const only: string[] = [];
  let acceptingSteps = false;
  for (const token of tokens) {
    if (token.kind === "option") {
      acceptingSteps = token.name === "only";
      if (acceptingSteps && token.value !== undefined) only.push(token.value);
    } else if (token.kind === "positional") {
      if (!acceptingSteps) throw new Error(`Unexpected argument: ${token.value}`);
      only.push(token.value);
    } else acceptingSteps = false;
  }
  const { from, plan } = values;
  if (from !== undefined && only.length) throw new Error("Use either --only or --from");
  for (const name of from === undefined ? only : [from])
    if (!all.some((step) => step.name === name))
      throw new Error(`Unknown ${command} step: ${name}`);
  return {
    steps:
      from !== undefined
        ? all.slice(all.findIndex((step) => step.name === from))
        : only.length
          ? all.filter((step) => only.includes(step.name))
          : all,
    plan,
  };
}

if (import.meta.main) {
  runMain(
    Effect.gen(function* () {
      if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
        yield* Effect.sync(() => {
          console.log(usage);
          console.log(`Setup steps: ${setupSteps.map((step) => step.name).join(", ")}`);
        });
        return;
      }
      if (process.geteuid?.() === 0)
        return yield* Effect.fail(
          new DotfilesError("Do not run as root; privileged tasks use sudo"),
        );
      const selected = yield* Effect.try({
        try: () => options(Bun.argv.slice(2)),
        catch: (error) =>
          new DotfilesError(error instanceof Error ? error.message : String(error)),
      });
      const host = yield* workstation;
      yield* Effect.forEach(
        selected.steps,
        (step) =>
          Effect.gen(function* () {
            if (host.nixos && !step.nixos) return;
            if (selected.plan)
              yield* Effect.sync(() =>
                console.log(`${step.name}: ${step.description}`),
              );
            else {
              yield* log(step.description);
              yield* step.action(host);
            }
          }),
        { discard: true },
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(
            `setup: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exitCode = 1;
        }),
      ),
    ),
  );
}
