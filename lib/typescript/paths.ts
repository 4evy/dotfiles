import { homedir } from "node:os";
import { join } from "node:path";

export function configHome(): string {
  return (
    process.env.XDG_CONFIG_HOME ??
    (process.platform === "darwin"
      ? join(homedir(), "Library/Application Support")
      : join(homedir(), ".config"))
  );
}

export function cachePath(...parts: string[]): string {
  const cache =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "darwin"
      ? join(homedir(), "Library/Caches")
      : join(homedir(), ".cache"));
  return join(cache, "dotfiles", ...parts);
}
