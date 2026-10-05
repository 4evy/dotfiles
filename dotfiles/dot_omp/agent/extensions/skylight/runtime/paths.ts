import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export const LINUX = process.platform === "linux";

function resourcesPath() {
  if (!LINUX) return "/Applications/ChatGPT.app/Contents/Resources";
  const executable = Bun.which("chatgpt");
  const directory = executable ? dirname(realpathSync(executable)) : undefined;
  const candidates = [
    ...(directory
      ? [join(directory, "resources"), join(directory, "../lib/chatgpt/resources")]
      : []),
    "/usr/lib/chatgpt/resources",
  ];
  return (
    candidates.find((path) => existsSync(join(path, "cua_node"))) ??
    "/usr/lib/chatgpt/resources"
  );
}

export const RESOURCES = resourcesPath();
export const MODULES = join(RESOURCES, "cua_node/lib/node_modules");
export const CODEX = join(RESOURCES, "codex-cli/bin/codex");
export const REPL = join(RESOURCES, "cua_node/bin/node_repl");
