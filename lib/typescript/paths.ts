import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, Option } from "effect";

function environmentDirectory(name: string, darwin: string, linux: string) {
  return Effect.gen(function* () {
    const configured = yield* Config.option(Config.String(name));
    if (Option.isSome(configured)) return configured.value;
    return yield* Effect.sync(() =>
      join(homedir(), process.platform === "darwin" ? darwin : linux),
    );
  });
}

export function configHome() {
  return environmentDirectory(
    "XDG_CONFIG_HOME",
    "Library/Application Support",
    ".config",
  );
}

export function cachePath(...parts: string[]) {
  return environmentDirectory("XDG_CACHE_HOME", "Library/Caches", ".cache").pipe(
    Effect.map((directory) => join(directory, "dotfiles", ...parts)),
  );
}
