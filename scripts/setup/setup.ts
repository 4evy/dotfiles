#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

// Bootstrap must work before installing repository dependencies
const root = resolve(import.meta.dir, "../..");
const minimumMacOSMajor = 27;
const homebrewRevision = "0a396a4ee5b538f409de666af904fa0570b53949";
const homebrewURL = `https://raw.githubusercontent.com/Homebrew/install/${homebrewRevision}/install.sh`;
const homebrewSHA256 =
  "f31a38f097f3b5bbfdc110658e4a9876d0c023ccc9ef2e70527f5b8a762e505e";
const gnuPackages = [
  "coreutils",
  "findutils",
  "gnu-sed",
  "grep",
  "gawk",
  "gnu-tar",
  "gnu-which",
  "diffutils",
  "make",
];

function log(message: string): void {
  console.log(`\n==> ${message}`);
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

type CommandOptions = {
  env?: NodeJS.ProcessEnv;
  capture?: boolean;
  quiet?: boolean;
  input?: string;
  check?: boolean;
};

class Workstation implements AsyncDisposable {
  readonly nixos = process.platform === "linux" && existsSync("/etc/NIXOS");
  readonly userBin = join(homedir(), ".local/bin");
  readonly brewPrefix: string;
  env: NodeJS.ProcessEnv;
  #sudoReady = false;
  #sudoDirectory: string | undefined;
  #sudoTimer: ReturnType<typeof setInterval> | undefined;
  #refresh: Promise<void> | undefined;
  readonly #abort = new AbortController();
  readonly #sigint = () => this.#abort.abort(new Error("Setup interrupted by SIGINT"));
  readonly #sigterm = () =>
    this.#abort.abort(new Error("Setup interrupted by SIGTERM"));

  constructor() {
    if (process.platform === "darwin") {
      if (process.arch !== "arm64")
        throw new Error("Use a native Apple Silicon terminal, not Rosetta");
      this.brewPrefix = "/opt/homebrew";
    } else if (process.platform === "linux") {
      if (!this.nixos && !existsSync("/usr/bin/bootc"))
        throw new Error("Linux workstation setup supports only BlueBuild and NixOS");
      this.brewPrefix = "/home/linuxbrew/.linuxbrew";
    } else throw new Error(`Unsupported platform: ${process.platform}`);
    const paths: string[] = [];
    if (process.platform === "linux" && !this.nixos)
      paths.push(
        join(
          process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
          "hjem/standalone/current-profile/bin",
        ),
      );
    paths.push(this.nixos ? "/run/current-system/sw/bin" : this.userBin);
    if (!this.nixos) {
      if (process.platform === "darwin") {
        paths.push(
          ...gnuPackages.map((name) =>
            join(this.brewPrefix, "opt", name, "libexec/gnubin"),
          ),
          join(this.brewPrefix, "opt/gnu-getopt/bin"),
        );
      }
      paths.push(
        join(this.brewPrefix, "bin"),
        join(this.brewPrefix, "sbin"),
        "/nix/var/nix/profiles/default/bin",
        join(homedir(), ".nix-profile/bin"),
      );
    }
    this.env = {
      ...process.env,
      PATH: [...paths, process.env.PATH ?? "/usr/bin:/bin"].join(delimiter),
      UV_PYTHON_BIN_DIR: this.userBin,
      UV_TOOL_BIN_DIR: this.userBin,
    };
    process.on("SIGINT", this.#sigint);
    process.on("SIGTERM", this.#sigterm);
  }

  async command(
    args: string[],
    options: CommandOptions = {},
  ): Promise<{ code: number; stdout: string }> {
    this.#abort.signal.throwIfAborted();
    const child = Bun.spawn(args, {
      cwd: root,
      env: options.env ?? this.env,
      stdin: options.input === undefined ? "inherit" : Buffer.from(options.input),
      stdout: options.capture ? "pipe" : options.quiet ? "ignore" : "inherit",
      stderr: options.quiet ? "ignore" : "inherit",
      signal: this.#abort.signal,
    });
    const [code, stdout] = await Promise.all([
      child.exited,
      child.stdout instanceof ReadableStream
        ? new Response(child.stdout).text()
        : Promise.resolve(""),
    ]);
    if (options.check !== false && code !== 0)
      throw new Error(`${args[0]} exited with status ${code}`);
    return { code, stdout };
  }

  async output(args: string[]): Promise<string> {
    return (await this.command(args, { capture: true })).stdout.trim();
  }

  async succeeds(args: string[], input?: string): Promise<boolean> {
    return (
      (
        await this.command(args, {
          quiet: true,
          check: false,
          ...(input === undefined ? {} : { input }),
        })
      ).code === 0
    );
  }

  async #password(): Promise<string> {
    if (!Bun.which("sudo", { PATH: this.env.PATH ?? "" }))
      throw new Error("Privileged tasks require sudo");
    const validate = (password: string) =>
      this.succeeds(["sudo", "-S", "-k", "-p", "", "-v"], `${password}\n`);
    let password = this.env.DOTFILES_SUDO_PASSWORD;
    if (password !== undefined && (await validate(password))) return password;
    try {
      password = readFileSync("/etc/bleh", "utf8").replace(/\n+$/, "");
    } catch {
      password = undefined;
    }
    if (password !== undefined && (await validate(password))) return password;
    if (!process.stdin.isTTY)
      throw new Error("Sudo authentication is required; run interactively");
    for (let attempt = 0; attempt < 3; attempt++) {
      password = await this.#promptPassword();
      if (await validate(password)) return password;
      console.error("Sorry, try again");
    }
    throw new Error("Failed to validate sudo credentials");
  }

  async #promptPassword(): Promise<string> {
    const terminalState = await this.output(["stty", "-g"]);
    await this.command(["stty", "-echo"]);
    const input = createInterface({ input: process.stdin, terminal: false });
    process.stderr.write(`[sudo] password for ${userInfo().username}: `);
    try {
      return await input.question("", { signal: this.#abort.signal });
    } finally {
      input.close();
      Bun.spawnSync(["stty", terminalState], {
        stdin: "inherit",
        stdout: "ignore",
        stderr: "inherit",
      });
      process.stderr.write("\n");
    }
  }

  async ensureSudo(): Promise<void> {
    if (this.#sudoReady) return;
    if (!this.env.SUDO_ASKPASS || !(await this.succeeds(["sudo", "-n", "-k", "-v"]))) {
      const password = await this.#password();
      const directory = mkdtempSync(join(tmpdir(), "dotfiles-sudo."));
      this.#sudoDirectory = directory;
      const helper = join(directory, "askpass");
      writeFileSync(
        helper,
        `#!/bin/sh\nprintf "%s\\n" "\${DOTFILES_SUDO_PASSWORD:?}"\n`,
        { mode: 0o700 },
      );
      const sudo =
        this.env.DOTFILES_REAL_SUDO ?? Bun.which("sudo", { PATH: this.env.PATH ?? "" });
      if (!sudo) throw new Error("Privileged tasks require sudo");
      // Both sudo calls share the wrapper's parent-PID authentication ticket
      writeFileSync(
        join(directory, "sudo"),
        '#!/bin/sh\n"$DOTFILES_REAL_SUDO" -A -v || exit "$?"\n"$DOTFILES_REAL_SUDO" "$@"\nexit "$?"\n',
        { mode: 0o700 },
      );
      this.env = {
        ...this.env,
        DOTFILES_SUDO_PASSWORD: password,
        DOTFILES_REAL_SUDO: sudo,
        SUDO_ASKPASS: helper,
        PATH: `${directory}${delimiter}${this.env.PATH}`,
      };
      await this.command([sudo, "-A", "-v"], { quiet: true });
      this.#sudoTimer = setInterval(() => {
        if (this.#refresh) return;
        this.#refresh = this.command([sudo, "-A", "-v"], { quiet: true, check: false })
          .then(
            () => undefined,
            () => undefined,
          )
          .finally(() => {
            this.#refresh = undefined;
          });
      }, 45_000);
      this.#sudoTimer.unref();
    }
    this.#sudoReady = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    process.off("SIGINT", this.#sigint);
    process.off("SIGTERM", this.#sigterm);
    if (this.#sudoTimer) clearInterval(this.#sudoTimer);
    await this.#refresh;
    if (this.#sudoDirectory)
      rmSync(this.#sudoDirectory, { recursive: true, force: true });
  }

  async #ensureHomebrew(): Promise<void> {
    const brew = join(this.brewPrefix, "bin/brew");
    if (executable(brew)) return;
    await this.ensureSudo();
    if (process.platform === "linux") {
      log("Activating image-provisioned Homebrew");
      await this.command(["sudo", "systemctl", "start", "brew-setup.service"]);
    } else {
      using workspace = mkdtempDisposableSync(join(tmpdir(), "dotfiles-bootstrap."));
      const temporary = workspace.path;
      const installer = join(temporary, "homebrew-install.sh");
      const url = this.env.HOMEBREW_INSTALLER_URL ?? homebrewURL;
      const checksum = (this.env.HOMEBREW_INSTALLER_CHECKSUM ?? homebrewSHA256)
        .replace(/^sha256:/, "")
        .toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(checksum))
        throw new Error("Homebrew installer requires a valid SHA-256 checksum");
      log("Downloading the Homebrew installer");
      await this.command([
        "curl",
        "-fsSL",
        "--retry",
        "3",
        "--retry-delay",
        "1",
        "-o",
        installer,
        url,
      ]);
      if (
        createHash("sha256").update(readFileSync(installer)).digest("hex") !== checksum
      )
        throw new Error("Homebrew installer checksum mismatch");
      log(`Installing Homebrew into ${this.brewPrefix}`);
      await this.command(["bash", installer], {
        env: { ...this.env, NONINTERACTIVE: "1" },
      });
    }
    if (!executable(brew)) throw new Error(`Homebrew did not create ${brew}`);
  }

  async prepareHomebrew(): Promise<void> {
    if (process.platform === "darwin") {
      const version = await this.output(["sw_vers", "-productVersion"]);
      if (Number(version.split(".")[0]) < minimumMacOSMajor)
        throw new Error(`macOS ${minimumMacOSMajor}+ is required; found ${version}`);
    }
    await this.#ensureHomebrew();
    if (
      (await this.output([join(this.brewPrefix, "bin/brew"), "--prefix"])) !==
      this.brewPrefix
    )
      throw new Error("Homebrew reported an unexpected prefix");
  }

  async installUv(): Promise<void> {
    if (!executable(join(this.brewPrefix, "bin/uv")))
      await this.command(
        [join(this.brewPrefix, "bin/brew"), "install", "--formula", "uv"],
        { env: { ...this.env, HOMEBREW_NO_ASK: "1" } },
      );
  }

  async installUserland(): Promise<void> {
    if (this.nixos) return;
    await this.ensureSudo();
    await this.command([
      process.execPath,
      join(root, "scripts/setup/homebrew.ts"),
      "bundle",
      ...(this.env.DOTFILES_HOMEBREW_UPGRADE === "1" ? ["--upgrade"] : []),
    ]);
    await this.command([
      join(this.brewPrefix, "bin/rustup"),
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
  }

  async installNix(): Promise<void> {
    if (this.nixos) return;
    await this.ensureSudo();
    if (!executable(join(this.brewPrefix, "bin/just")))
      await this.command([join(this.brewPrefix, "bin/brew"), "install", "just", "jq"]);
    await this.command([join(this.brewPrefix, "bin/just"), "nix", "_ensure"]);
    if (process.platform === "linux")
      await this.command([join(this.brewPrefix, "bin/just"), "nix"]);
  }

  async configureHost(): Promise<void> {
    if (process.platform === "darwin") {
      await this.ensureSudo();
      const darwinSource = await this.output([
        "nix",
        "eval",
        "--impure",
        "--raw",
        "--expr",
        "(import ./flake.nix).inputs.darwin.url",
      ]);
      // Refresh local working trees after edits change their recorded NAR hash
      if (darwinSource.startsWith("git+file:") || darwinSource.startsWith("path:"))
        await this.command(["nix", "flake", "update", "darwin", "--allow-dirty-locks"]);
      const system = await this.output([
        "nix",
        "build",
        ".#darwin.configurations.evy.system",
        "--no-link",
        "--print-out-paths",
      ]);
      await this.command([
        "sudo",
        "--preserve-env=DOTFILES_SUDO_PASSWORD,SUDO_ASKPASS",
        join(system, "activate"),
        "--profile",
        "/nix/var/nix/profiles/system",
      ]);
    } else {
      if (!this.nixos) await this.#configureBootc();
      await this.command(["python3.14", join(root, "scripts/setup/toshy.py")]);
    }
  }

  async #configureBootc(): Promise<void> {
    await this.ensureSudo();
    const farstep = await this.output([
      "nix",
      "build",
      `${root}#farstep`,
      "--no-link",
      "--print-out-paths",
    ]);
    const nixEnv = Bun.which("nix-env", { PATH: this.env.PATH ?? "" });
    if (!nixEnv) throw new Error("Nix is missing nix-env");
    const profile = "/nix/var/nix/profiles/dotfiles-farstep";
    await this.command(["sudo", nixEnv, "--profile", profile, "--set", farstep]);
    await this.command([
      "sudo",
      "ln",
      "--symbolic",
      "--force",
      "--no-dereference",
      `${profile}/bin/farstep-desktop`,
      "/usr/local/bin/farstep-desktop",
    ]);
    const user = userInfo().username;
    for (const group of ["input", "uinput"])
      await this.command(["sudo", "usermod", "--append", "--groups", group, user]);
    await this.command(["sudo", "usermod", "--shell", "/bin/zsh", user]);
    await this.command(["sudo", "modprobe", "uinput"]);
    if (
      this.env.DOTFILES_KEEP_INPUT_REMAPPER !== "1" &&
      (await this.succeeds(["systemctl", "cat", "input-remapper.service"]))
    )
      await this.command([
        "sudo",
        "systemctl",
        "mask",
        "--now",
        "input-remapper.service",
      ]);
    await this.command(["sudo", "systemctl", "start", "kanata-main.service"]);
  }

  async installPython(): Promise<void> {
    mkdirSync(this.userBin, { recursive: true });
    await this.command(["uv", "python", "install", "3.14", "--default"]);
  }

  async installWorkstation(): Promise<void> {
    await this.command([process.execPath, join(root, "scripts/setup/workstation.ts")]);
  }

  async applyDotfiles(): Promise<void> {
    await this.command(["just", "apply"]);
  }
}

type Step = {
  name: string;
  description: string;
  action: (host: Workstation) => Promise<void>;
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
    name: "python",
    description: "Install Python for Toshy",
    action: (host) => host.installPython(),
  },
  {
    name: "workstation",
    description: "Install the Bun workstation commands",
    action: (host) => host.installWorkstation(),
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
  try {
    if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
      console.log(usage);
      console.log(`Setup steps: ${setupSteps.map((step) => step.name).join(", ")}`);
    } else {
      if (process.geteuid?.() === 0)
        throw new Error("Do not run as root; privileged tasks use sudo");
      const selected = options(Bun.argv.slice(2));
      await using host = new Workstation();
      for (const step of selected.steps) {
        if (host.nixos && !step.nixos) continue;
        if (selected.plan) console.log(`${step.name}: ${step.description}`);
        else {
          log(step.description);
          await step.action(host);
        }
      }
    }
  } catch (error) {
    console.error(`setup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
