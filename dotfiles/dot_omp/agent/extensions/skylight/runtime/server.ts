import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CODEX, LINUX, MODULES, REPL, RESOURCES } from "./paths";

export function runtimeServer(ctx: ExtensionContext) {
  const service = join(homedir(), ".codex/computer-use/Codex Computer Use.app");
  const bundledService = join(MODULES, "@oai/sky/Codex Computer Use.app");
  const node = join(RESOURCES, "cua_node/bin/node");
  for (const path of [
    ...(!LINUX ? [CODEX] : []),
    REPL,
    node,
    join(MODULES, "@oai/sky/package.json"),
  ]) {
    if (!existsSync(path))
      throw new Error(`ChatGPT computer-use runtime missing: ${path}`);
  }
  const env: Record<string, string> = {
    // Omp does not need the bundled Skylight library's app-use analytics
    NODE_REPL_DISABLE_ANALYTICS: "1",
    NODE_REPL_NODE_PATH: node,
    NODE_REPL_NODE_MODULE_DIRS: MODULES,
    NODE_REPL_TRUSTED_CODE_PATHS: MODULES,
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
    ...(!LINUX
      ? {
          CODEX_CLI_PATH: CODEX,
          CODEX_HOME: join(homedir(), ".codex"),
          SKY_CUA_SERVICE_PATH: existsSync(service) ? service : bundledService,
        }
      : {}),
  };
  return {
    // macOS authenticates sender ancestry; keep its signed Codex parent
    command: LINUX ? REPL : CODEX,
    args: LINUX
      ? []
      : ["sandbox", "-c", 'sandbox_mode="danger-full-access"', "--", REPL],
    cwd: ctx.cwd,
    // Cell deadlines belong to js; only the handshake gets our 30s limit
    timeout: 0,
    env,
  };
}
