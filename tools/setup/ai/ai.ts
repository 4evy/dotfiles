#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtempDisposable, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareAiHome } from "./home.ts";

const root = resolve(import.meta.dir, "../../..");

// Hjem setup must run before repository npm dependencies are installed
async function run(argv: string[], cwd = root, env = process.env): Promise<string> {
  const process = Bun.spawn(argv, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) throw new Error(`${argv[0]} failed`);
  return output.trim();
}

const actions = {
  apply: { generate: true, provisionFarstep: true },
  generate: { generate: true, provisionFarstep: true },
  setup: { generate: false, provisionFarstep: true },
  configure: { generate: false, provisionFarstep: false },
  activate: { generate: false, provisionFarstep: false },
};
const usage = "Usage: ai.ts [apply|generate|setup|configure|activate]";
const action = Bun.argv[2] ?? "apply";
if (!Object.hasOwn(actions, action)) throw new Error(usage);
const rules = actions[action as keyof typeof actions];
const setupArguments = Bun.argv.slice(3);
if (action !== "setup" && setupArguments.length)
  throw new Error(`${action} does not accept arguments`);

if (action === "activate") {
  const home = homedir();
  await mkdir(join(home, ".local/state/ghidra-mcp-headless"), {
    recursive: true,
    mode: 0o700,
  });
  if (process.platform === "linux" && Bun.which("systemctl")) {
    await run(["systemctl", "--user", "daemon-reload"]);
    const environment = join(home, ".config/environment.d/60-codex-cli.conf");
    if (existsSync(environment)) {
      const value = (await Bun.file(environment).text())
        .trim()
        .slice("CODEX_CLI_PATH=".length);
      const cli = JSON.parse(value);
      const command = Bun.which("dbus-update-activation-environment")
        ? ["dbus-update-activation-environment", "--systemd", `CODEX_CLI_PATH=${cli}`]
        : ["systemctl", "--user", "set-environment", `CODEX_CLI_PATH=${cli}`];
      await run(command);
    }
    await run(["systemctl", "--user", "enable", "ghidra-mcp.service"]);
    await run(["systemctl", "--user", "restart", "ghidra-mcp.service"]);
  }
  process.exit(0);
}

// Darwin activates user settings through its native module
if (action !== "apply" || process.platform === "linux") {
  const lock = await Bun.file(join(root, "flake.lock")).json();
  const node = lock.nodes[lock.nodes[lock.root].inputs.ai];
  const revision: unknown = node.locked.rev;
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision))
    throw new Error("The AI input must lock a GitHub revision");
  const parent = join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"),
    "dotfiles/ai",
  );
  const source = join(parent, revision);
  const missingSource = !(await Bun.file(join(source, "flake.nix")).exists());
  const sourcePath = missingSource
    ? JSON.parse(
        await run(["nix", "flake", "prefetch", "--json", "--inputs-from", root, "ai"]),
      ).storePath
    : "";
  if (missingSource) {
    await mkdir(parent, { recursive: true });
    {
      await using workspace = await mkdtempDisposable(join(parent, ".install-"));
      const staging = workspace.path;
      await cp(sourcePath, staging, { recursive: true, mode: 0 });
      await run(["chmod", "-R", "u+w", staging]);
      await rename(staging, source);
    }
  }
  await run(
    [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
    source,
  );
  let farstepPackage = "";
  if (
    process.platform === "linux" &&
    !existsSync("/etc/NIXOS") &&
    rules.provisionFarstep
  ) {
    const state = join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
      "farstep",
    );
    await mkdir(state, { recursive: true });
    farstepPackage = await run([
      "nix",
      "build",
      `${root}#farstep`,
      "--out-link",
      join(state, "package"),
      "--print-out-paths",
    ]);
  }
  if (action === "setup") {
    await run(
      [
        process.execPath,
        "--eval",
        'const { setup } = await import("./tools/scripts/setup/setup.ts"); await setup(Bun.argv.slice(1), { background: process.env.HJEM_ACTIVATING === "1" });',
        "codex",
        "claude",
        "opencode",
        ...setupArguments,
      ],
      source,
      { ...process.env, AI_TOOLS_FLAKE: root },
    );
  } else if (action === "configure") {
    await run(
      [process.execPath, "tools/scripts/cli/cli.ts", "chatgpt", "configure"],
      source,
    );
  } else if (rules.generate) {
    {
      await using workspace = await mkdtempDisposable(
        join(tmpdir(), "dotfiles-ai-configs-"),
      );
      const temporary = workspace.path;
      const hostFile = join(temporary, "host.json");
      const runtime = await run([
        "nix",
        "build",
        `${root}#ai-tools`,
        "--no-link",
        "--print-out-paths",
      ]);
      const host = JSON.parse(
        await run(
          [process.execPath, "config/settings/generate/generate.ts", "--print-host"],
          source,
        ),
      );
      host.farstep =
        (farstepPackage && join(farstepPackage, "bin/farstep")) ||
        (process.platform === "linux" &&
          Bun.which("/run/current-system/sw/bin/farstep")) ||
        join(source, "farstep/farstep");
      if (process.platform === "linux")
        host.codexCli = await run(
          [
            process.execPath,
            "--eval",
            'import { findBinary } from "./tools/scripts/setup/binary.ts"; console.log(findBinary("codex"));',
          ],
          source,
        );
      await Bun.write(hostFile, JSON.stringify(host));
      const argument = JSON.stringify(
        JSON.stringify({
          system: `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform}`,
          hostFile,
        }),
      ).replaceAll("${", "\\${");
      const derivation = await run([
        "nix",
        "eval",
        "--impure",
        "--raw",
        `${root}#lib.aiConfigs`,
        "--apply",
        `build: (build ${argument}).drvPath`,
      ]);
      const exported = await run([
        "nix",
        "build",
        `${derivation}^*`,
        "--no-link",
        "--print-out-paths",
      ]);
      const generated = join(root, ".generated");
      await mkdir(generated, { recursive: true, mode: 0o700 });
      {
        await using stagingDirectory = await mkdtempDisposable(
          join(generated, ".ai-configs-"),
        );
        const staging = stagingDirectory.path;
        await prepareAiHome(
          source,
          exported,
          staging,
          host.codexCli ?? "",
          join(runtime, "bin/omp"),
          host.farstep,
        );
        const destination = join(generated, "ai-configs");
        const backup = join(generated, "ai-configs.previous");
        await rm(backup, { recursive: true, force: true });
        const previous = existsSync(destination);
        if (previous) await rename(destination, backup);
        try {
          await rename(staging, destination);
        } catch (error) {
          if (previous) await rename(backup, destination);
          throw error;
        }
        await rm(backup, { recursive: true, force: true });
      }
    }
    if (action === "apply")
      await run([process.execPath, join(root, "home/deploy/apply.ts"), "apply"], root, {
        ...process.env,
        DOTFILES_AI_PREPARED: "1",
      });
  }
}
