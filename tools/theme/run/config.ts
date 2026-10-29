import { basename, delimiter, join } from "node:path";
import { DotfilesError } from "@dotfiles/core/errors";
import { Effect, FileSystem } from "effect";
import { parse } from "smol-toml";
import * as v from "valibot";
import defaults from "./defaults.toml" with { type: "text" };

export const name = "theme-run";
export const version = "0.1.0";
export const maxFileBytes = 1024 * 1024;
export type Theme = "dark" | "light";
export type Variables = Record<string, string>;
export interface Platform {
  commands: string[][];
  fallback: Theme;
}
export interface Runtime {
  theme_environment: string[];
  theme_aliases: Record<Theme, string[]>;
  theme_terminal_program_environment: string;
  theme_terminal_queries: Record<string, "background" | "color-scheme">;
  theme_platforms: Record<string, Platform>;
  theme_probe_timeout_ms: number;
  helper_timeout_ms: number;
  helper_output_limit_bytes: number;
}
export interface Interpreter {
  name: string;
  shebang_commands: string[];
  shebang_arguments: string[];
  programs: string[];
}
export interface Runner {
  name: string;
  aliases: string[];
  programs: string[];
  skip_env: string[];
  default_args: string[];
  env: Variables;
  env_unset: string[];
  integration: string;
  interpreter: string;
}
export interface Integration {
  name: string;
  strategy: "arguments" | "config" | "environment";
  dark_theme: string;
  light_theme: string;
  arguments: string[];
  env: Variables;
  default_config: string;
  assignment: string;
  config_flags: string[];
  config_output_flag: string;
  temporary_prefix: string;
  temporary_location: string;
  cache_subdirectory: string;
  quote: string;
}
interface Fragment {
  runtime?: Runtime;
  interpreter: Interpreter[];
  runner: Runner[];
  integration: Integration[];
}

const text = v.string();
const requiredText = v.pipe(text, v.minLength(1));
const texts = v.optional(v.array(text), () => []);
const requiredTexts = v.pipe(v.array(requiredText), v.minLength(1));
const environmentName = v.pipe(
  text,
  v.check((value) => value.length > 0 && !value.includes("=") && !value.includes("\0")),
);
const environment = v.optional(v.record(text, text), () => ({}));
const optionalText = v.optional(text, "");
const integer = v.pipe(v.number(), v.integer());
const theme = v.picklist(["dark", "light"]);
const timeout = v.pipe(integer, v.minValue(1), v.maxValue(60_000));

const platformEntries = {
  commands: v.optional(v.array(v.array(text)), () => []),
  fallback: text,
};
const runtimeEntries = {
  theme_environment: v.array(text),
  theme_aliases: v.strictObject({ dark: v.array(text), light: v.array(text) }),
  theme_terminal_program_environment: text,
  theme_terminal_queries: v.record(text, text),
  theme_platforms: v.record(
    text,
    v.partial(v.strictObject(platformEntries), ["fallback"]),
  ),
  theme_probe_timeout_ms: integer,
  helper_timeout_ms: integer,
  helper_output_limit_bytes: integer,
};
const interpreterEntries = {
  name: text,
  shebang_commands: v.array(text),
  shebang_arguments: v.array(text),
  programs: v.array(text),
};
const runnerEntries = {
  name: text,
  aliases: texts,
  programs: texts,
  skip_env: texts,
  default_args: texts,
  env: environment,
  env_unset: texts,
  integration: optionalText,
  interpreter: optionalText,
};
const integrationEntries = {
  name: text,
  strategy: text,
  dark_theme: text,
  light_theme: text,
  arguments: texts,
  env: environment,
  default_config: optionalText,
  assignment: optionalText,
  config_flags: texts,
  config_output_flag: optionalText,
  temporary_prefix: optionalText,
  temporary_location: optionalText,
  cache_subdirectory: optionalText,
  quote: optionalText,
};

// Decode types and defaults first, validate constraints after profile replacement
const decodedFragmentSchema = v.strictObject({
  runtime: v.exactOptional(
    v.partial(
      v.strictObject({
        ...runtimeEntries,
        theme_aliases: v.partial(runtimeEntries.theme_aliases),
      }),
    ),
  ),
  interpreter: v.optional(
    v.array(v.partial(v.strictObject(interpreterEntries))),
    () => [],
  ),
  runner: v.optional(
    v.array(v.partial(v.strictObject(runnerEntries), ["name"])),
    () => [],
  ),
  integration: v.optional(
    v.array(
      v.partial(v.strictObject(integrationEntries), [
        "name",
        "strategy",
        "dark_theme",
        "light_theme",
      ]),
    ),
    () => [],
  ),
});
const fragmentSchema = v.strictObject({
  runtime: v.exactOptional(
    v.strictObject({
      ...runtimeEntries,
      theme_environment: v.pipe(v.array(text), v.minLength(1)),
      theme_aliases: v.strictObject({ dark: requiredTexts, light: requiredTexts }),
      theme_terminal_program_environment: requiredText,
      theme_terminal_queries: v.pipe(
        v.record(text, v.picklist(["background", "color-scheme"])),
        v.check((queries) => Object.hasOwn(queries, "*")),
      ),
      theme_platforms: v.pipe(
        v.record(
          requiredText,
          v.strictObject({
            commands: v.optional(v.array(requiredTexts), () => []),
            fallback: theme,
          }),
        ),
        v.check((platforms) => Object.hasOwn(platforms, "*")),
      ),
      theme_probe_timeout_ms: timeout,
      helper_timeout_ms: timeout,
      helper_output_limit_bytes: v.pipe(
        integer,
        v.minValue(1),
        v.maxValue(maxFileBytes),
      ),
    }),
  ),
  interpreter: v.optional(
    v.array(
      v.strictObject({
        name: requiredText,
        shebang_commands: requiredTexts,
        shebang_arguments: requiredTexts,
        programs: requiredTexts,
      }),
    ),
    () => [],
  ),
  runner: v.optional(
    v.array(
      v.strictObject({
        ...runnerEntries,
        name: requiredText,
        aliases: v.optional(v.array(requiredText), () => []),
        programs: v.optional(
          v.array(
            v.pipe(
              text,
              v.check((value) => value !== "$"),
            ),
          ),
          () => [],
        ),
        skip_env: v.optional(v.array(environmentName), () => []),
        env: v.optional(v.record(environmentName, text), () => ({})),
        env_unset: v.optional(v.array(environmentName), () => []),
      }),
    ),
    () => [],
  ),
  integration: v.optional(
    v.array(
      v.strictObject({
        ...integrationEntries,
        name: requiredText,
        strategy: v.picklist(["arguments", "config", "environment"]),
        dark_theme: requiredText,
        light_theme: requiredText,
        env: v.optional(v.record(environmentName, text), () => ({})),
      }),
    ),
    () => [],
  ),
}) satisfies v.GenericSchema<unknown, Fragment>;

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error) return String(error.code);
  if ("reason" in error && error.reason && typeof error.reason === "object") {
    const reason = error.reason;
    if ("_tag" in reason) {
      if (reason._tag === "NotFound") return "ENOENT";
      if (reason._tag === "AlreadyExists") return "EEXIST";
      if (reason._tag === "PermissionDenied") return "EACCES";
    }
    if ("cause" in reason) return errorCode(reason.cause);
  }
  return "cause" in error ? errorCode(error.cause) : undefined;
}

export function readFile(path: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(path, { flag: "r" });
      const buffer = Buffer.allocUnsafe(maxFileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const bytesRead = yield* file.read(buffer.subarray(length));
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxFileBytes)
        return yield* Effect.fail(
          new DotfilesError(`file exceeds ${maxFileBytes} bytes`),
        );
      return buffer.toString("utf8", 0, length);
    }),
  );
}

export function configPaths(env: Variables): string[] {
  if (env.THEME_RUN_CONFIG !== undefined)
    return env.THEME_RUN_CONFIG.split(delimiter).filter(Boolean);
  if (env.XDG_CONFIG_HOME) return [join(env.XDG_CONFIG_HOME, name, "config.toml")];
  if (env.HOME) return [join(env.HOME, ".config", name, "config.toml")];
  return [];
}

export class Manifest {
  runtime!: Runtime;
  readonly runners = new Map<string, Runner>();
  readonly integrations = new Map<string, Integration>();
  readonly interpreters = new Map<string, Interpreter>();
  readonly aliases = new Map<string, string>();

  static load(env: Variables) {
    return Effect.gen(function* () {
      const manifest = new Manifest();
      yield* Effect.try({
        try: () => manifest.loadFragment(defaults, "embedded defaults.toml"),
        catch: (cause) =>
          new DotfilesError(cause instanceof Error ? cause.message : String(cause), {
            cause,
          }),
      });
      for (const path of configPaths(env)) {
        const contents = yield* readFile(path).pipe(
          Effect.catch((cause) =>
            errorCode(cause) === "ENOENT"
              ? Effect.succeed(undefined)
              : Effect.fail(
                  new DotfilesError(`read ${path}: ${String(cause)}`, { cause }),
                ),
          ),
        );
        if (contents === undefined) continue;
        yield* Effect.try({
          try: () => manifest.loadFragment(contents, path),
          catch: (cause) =>
            new DotfilesError(cause instanceof Error ? cause.message : String(cause), {
              cause,
            }),
        });
      }
      yield* Effect.try({
        try: () => manifest.validate(),
        catch: (cause) =>
          new DotfilesError(cause instanceof Error ? cause.message : String(cause), {
            cause,
          }),
      });
      return manifest;
    });
  }

  private loadFragment(contents: string, source: string): void {
    try {
      // Required fields and enum constraints may be repaired by later fragments
      const value = v.parse(decodedFragmentSchema, parse(contents)) as Fragment;
      if (value.runtime) this.runtime = value.runtime;
      for (const item of value.interpreter) this.interpreters.set(item.name, item);
      for (const item of value.runner) this.runners.set(item.name, item);
      for (const item of value.integration) this.integrations.set(item.name, item);
    } catch (error) {
      throw new Error(`parse ${source}: ${String(error)}`, { cause: error });
    }
  }

  findRunner(command: string): Runner | undefined {
    const key = basename(command);
    return this.runners.get(key) ?? this.runners.get(this.aliases.get(key) ?? "");
  }

  private validate(): void {
    const value = {
      runtime: this.runtime,
      interpreter: [...this.interpreters.values()],
      runner: [...this.runners.values()],
      integration: [...this.integrations.values()],
    };
    v.parse(fragmentSchema, value);
    for (const item of this.integrations.values()) {
      if (
        item.strategy === "arguments" &&
        !item.arguments.some((arg) => arg.includes("{theme}"))
      ) {
        throw new Error("argument strategy must use {theme}");
      }
      if (
        item.strategy === "environment" &&
        !Object.values(item.env).some((value) => value.includes("{theme}"))
      ) {
        throw new Error("environment strategy must use {theme}");
      }
      if (item.strategy === "config") {
        for (const key of [
          "default_config",
          "assignment",
          "config_output_flag",
          "temporary_prefix",
        ] as const) {
          if (!item[key])
            throw new Error(
              `integration ${JSON.stringify(item.name)}: ${key} is required`,
            );
        }
        if (!item.config_flags.length) throw new Error("config_flags is required");
        if (!["system", "cache"].includes(item.temporary_location))
          throw new Error("invalid temporary_location");
        if (item.temporary_location === "cache" && !item.cache_subdirectory)
          throw new Error("cache_subdirectory is required");
        if (!["'", '"'].includes(item.quote))
          throw new Error("quote must be a single or double quote");
        if (
          !item.temporary_prefix.endsWith("XXXXXX") ||
          basename(item.temporary_prefix) !== item.temporary_prefix
        ) {
          throw new Error("temporary prefix must be a basename ending in XXXXXX");
        }
      }
    }
    for (const [key, item] of this.runners) {
      for (const alias of item.aliases) {
        if (this.runners.has(alias))
          throw new Error(
            `runner alias ${JSON.stringify(alias)} collides with a runner`,
          );
        if (this.aliases.has(alias))
          throw new Error(`duplicate runner alias ${JSON.stringify(alias)}`);
        this.aliases.set(alias, key);
      }
      if (item.integration && !this.integrations.has(item.integration)) {
        throw new Error(
          `runner ${JSON.stringify(key)} references missing integration ${JSON.stringify(item.integration)}`,
        );
      }
      if (item.interpreter && !this.interpreters.has(item.interpreter)) {
        throw new Error(
          `runner ${JSON.stringify(key)} references missing interpreter ${JSON.stringify(item.interpreter)}`,
        );
      }
    }
  }
}
