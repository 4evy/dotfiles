import {
  chmod,
  mkdir,
  mkdtempDisposable,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Server = {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  disabled?: boolean;
  timeout?: { catalog?: number; execution?: number };
};

const home = process.env.HJEM_HOME_DIR || homedir();
const source = await Bun.file(join(home, ".config/opencode/opencode.json")).json();
const servers: Record<string, Server> = source.mcp.servers;
// 1Password's native MCP integration is configured by Codex, not OpenCode
const codexFile = Bun.file(join(home, ".codex/config.toml"));
if (await codexFile.exists()) {
  const codex = Bun.TOML.parse(await codexFile.text()) as {
    mcp_servers?: {
      "1password"?: {
        command: string;
        args?: string[];
        enabled?: boolean;
        startup_timeout_sec?: number;
        tool_timeout_sec?: number;
      };
    };
  };
  const password = codex.mcp_servers?.["1password"];
  if (password?.enabled && password.command)
    servers["1password"] = {
      type: "local",
      command: [password.command, ...(password.args ?? [])],
      timeout: {
        catalog: (password.startup_timeout_sec ?? 30) * 1000,
        execution: (password.tool_timeout_sec ?? 120) * 1000,
      },
    };
}
const managed = Object.fromEntries(
  Object.entries(servers).map(([name, server]) => {
    if (server.type !== "local" || !server.command.length)
      throw new Error(`Cannot mirror unsupported MCP transport for ${name}`);
    let [command, ...args] = server.command;
    if (name === "farstep_desktop" || name === "farstep_system") {
      args = [fileURLToPath(new URL("./mcp.ts", import.meta.url)), ...server.command];
      command = process.execPath;
    } else if (name === "ghidra") {
      // Reuse cxg's service-owned backend, including desktop cold starts
      args = [
        "-e",
        "-c",
        'source "$HOME/.config/shell/interactive.d/40-host-tools.sh"; ' +
          '_dotfiles_start_ghidra_mcp_for_cxg; exec "$@"',
        "antigravity-ghidra",
        ...server.command,
      ];
      command = "bash";
    }
    const timeout = Math.max(
      server.timeout?.catalog ?? 0,
      server.timeout?.execution ?? 0,
    );
    return [
      name,
      {
        command,
        args,
        ...(server.environment && { env: server.environment }),
        ...(server.disabled !== undefined && { disabled: server.disabled }),
        ...(timeout > 0 && { timeoutSeconds: Math.ceil(timeout / 1000) }),
      },
    ];
  }),
);
const directory = join(home, ".gemini/config");
const target = join(directory, "mcp_config.json");
await mkdir(directory, { recursive: true, mode: 0o700 });
let original = "";
try {
  original = await readFile(target, "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const current = original.trim() ? JSON.parse(original) : {};
const updated = {
  ...current,
  mcpServers: { ...current.mcpServers, ...managed },
};
const contents = `${JSON.stringify(updated, null, 2)}\n`;
if (contents !== original) {
  await using temporary = await mkdtempDisposable(join(directory, ".dotfiles-mcp-"));
  const staging = join(temporary.path, "mcp_config.json");
  await writeFile(staging, contents, { mode: 0o600 });
  const latest = (await Bun.file(target).exists())
    ? await readFile(target, "utf8")
    : "";
  if (latest !== original)
    throw new Error(
      "Antigravity MCP settings changed during apply, run just apply again",
    );
  await rename(staging, target);
}
await chmod(target, 0o600);
