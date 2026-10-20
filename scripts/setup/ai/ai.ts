#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareAiHome } from "./home.ts";

const root = resolve(import.meta.dir, "../../..");

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

const action = Bun.argv[2] ?? "apply";
const setupArguments = Bun.argv.slice(3);
if (!["apply", "generate", "setup", "configure", "activate"].includes(action))
  throw new Error("Usage: ai.ts [apply|generate|setup|configure|activate]");

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
  const sourcePath =
    missingSource || action === "apply" || action === "generate"
      ? JSON.parse(
          await run([
            "nix",
            "flake",
            "prefetch",
            "--json",
            "--inputs-from",
            root,
            "ai",
          ]),
        ).storePath
      : "";
  if (missingSource) {
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(join(parent, ".install-"));
    try {
      await cp(sourcePath, staging, { recursive: true, mode: 0 });
      await run(["chmod", "-R", "u+w", staging]);
      await rename(staging, source);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await run(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], source);
  let farstepPackage = "";
  if (
    process.platform === "linux" &&
    !existsSync("/etc/NIXOS") &&
    ["apply", "generate", "setup"].includes(action)
  ) {
    const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
    farstepPackage = await run([
      "nix",
      "build",
      `${root}#farstep`,
      "--out-link",
      join(state, "farstep/package"),
      "--print-out-paths",
    ]);
  }
  if (action === "setup") {
    await run(
      [
        "bun",
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
    await run(["bun", "tools/scripts/cli/cli.ts", "chatgpt", "configure"], source);
  } else {
    const temporary = await mkdtemp(join(tmpdir(), "dotfiles-ai-configs-"));
    try {
      const hostFile = join(temporary, "host.json");
      const host = JSON.parse(
        await run(
          ["bun", "config/settings/generate/generate.ts", "--print-host"],
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
            "bun",
            "--eval",
            'import { findBinary } from "./tools/scripts/setup/binary.ts"; console.log(findBinary("codex"));',
          ],
          source,
        );
      await Bun.write(hostFile, JSON.stringify(host));
      const builds = JSON.parse(
        await run([
          "nix",
          "build",
          "--impure",
          "--no-link",
          "--json",
          "--file",
          join(sourcePath, "config/settings/generate/build.nix"),
          "--argstr",
          "repository",
          sourcePath,
          "--argstr",
          "system",
          `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform}`,
          "--argstr",
          "hostFile",
          hostFile,
        ]),
      );
      const generated = join(root, ".generated");
      await mkdir(generated, { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(join(generated, ".ai-configs-"));
      try {
        await prepareAiHome(
          source,
          builds[0].outputs.out,
          staging,
          host.codexCli ?? "",
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
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    if (action === "apply")
      await run(["bash", "scripts/hjem/hjem.sh", "apply"], root, {
        ...process.env,
        DOTFILES_AI_PREPARED: "1",
      });
  }
}
