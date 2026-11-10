import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DotfilesError } from "@dotfiles/core/errors";
import ompConfig from "@dotfiles/home/data/omp/config";
import keybindings from "@dotfiles/home/data/omp/keybindings";
import opencodeConfig from "@dotfiles/home/data/opencode/config";
import quotaToast from "@dotfiles/home/data/opencode/quota/toast";
import {
  type PreparedAiManifest,
  PreparedAiManifestSchema,
} from "@dotfiles/home/schema";
import { Effect, FileSystem, Schema } from "effect";

type Configuration = Record<string, unknown>;

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const publicFileMode = 0o644;
const jsonIndentSpaces = 2;
const manifestFilename = "manifest.json";
const ghidraRestartDelaySeconds = 5;
const privateServiceUmask = "0077";

const ConfigurationSchema = Schema.Record(Schema.String, Schema.Unknown);
const ExportManifestSchema = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      private: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

const formats = {
  toml: {
    parse: Bun.TOML.parse,
    stringify: (value: Configuration) => Bun.TOML.stringify(value),
  },
  yaml: {
    parse: Bun.YAML.parse,
    stringify: (value: Configuration) => Bun.YAML.stringify(value),
  },
  json: {
    parse: JSON.parse,
    stringify: (value: Configuration) =>
      `${JSON.stringify(value, null, jsonIndentSpaces)}\n`,
  },
};

function merge(left: Configuration, right: Configuration): Configuration {
  for (const [key, value] of Object.entries(right)) {
    const previous = left[key];
    left[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      previous &&
      typeof previous === "object" &&
      !Array.isArray(previous)
        ? merge(previous as Configuration, value as Configuration)
        : value;
  }
  return left;
}

type ConfigRule = {
  format: keyof typeof formats;
  preserveCurrent?: boolean;
  onlyIfCurrentExists?: boolean;
  // Shallow replacements in the export, before merging with current state
  managedOverrides?: Configuration;
  // Deep-merged last, after both current state and the managed export
  overrides?: Configuration | ((managed: Configuration) => Configuration);
};

// Native-shaped preferences live in home/data, while merge policy stays here
const configRules: Record<string, ConfigRule> = {
  ".codex/config.toml": {
    format: "toml",
    preserveCurrent: true,
    onlyIfCurrentExists: true,
  },
  ".omp/agent/config.yml": {
    format: "yaml",
    preserveCurrent: true,
    // Replace exported appearance and notification policy before runtime merging
    managedOverrides: ompConfig,
  },
  ".omp/agent/keybindings.yml": {
    format: "yaml",
    preserveCurrent: true,
    overrides: keybindings,
  },
  ".config/opencode/opencode.json": {
    format: "json",
    // Keep migration-owned preferences independent of the pinned AI export
    overrides: (managed) => ({
      ...opencodeConfig,
      watcher: {
        ...opencodeConfig.watcher,
        ignore: [
          ...new Set([
            ...((managed.watcher as { ignore?: string[] } | undefined)?.ignore ?? []),
            ...opencodeConfig.watcher.ignore,
          ]),
        ],
      },
    }),
  },
  ".config/opencode/opencode-quota/quota-toast.json": {
    format: "json",
    overrides: quotaToast,
  },
};

const readConfiguration = Effect.fn("readAiConfiguration")(function* (
  path: string,
  format: keyof typeof formats,
  emptyIfNull = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path);
  const value = yield* Effect.try({
    try: () => formats[format].parse(text) as unknown,
    catch: (error) => new DotfilesError(`Invalid AI configuration ${path}: ${error}`),
  });
  return yield* Schema.decodeUnknownEffect(ConfigurationSchema)(
    emptyIfNull && value == null ? {} : value,
  );
});

const renderConfiguration = Effect.fn("renderAiConfiguration")(function* (
  rule: ConfigRule,
  currentPath: string,
  currentExists: boolean,
  exported: string,
  path: string,
) {
  const current =
    rule.preserveCurrent && currentExists
      ? yield* readConfiguration(currentPath, rule.format, true)
      : {};
  const managed = yield* readConfiguration(join(exported, path), rule.format);
  const config = rule.preserveCurrent
    ? merge(
        current,
        rule.managedOverrides ? { ...managed, ...rule.managedOverrides } : managed,
      )
    : managed;
  const overrides =
    typeof rule.overrides === "function" ? rule.overrides(managed) : rule.overrides;
  return yield* Effect.try({
    try: () =>
      formats[rule.format].stringify(overrides ? merge(config, overrides) : config),
    catch: (error) =>
      new DotfilesError(`Could not render AI configuration ${path}: ${error}`),
  });
});

const prepareExportedFile = Effect.fn("prepareExportedAiFile")(function* (
  file: (typeof ExportManifestSchema.Type)["files"][number],
  exported: string,
  destination: string,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (
    isAbsolute(file.path) ||
    file.path.split("/").some((part) => ["", ".", ".."].includes(part))
  )
    return yield* Effect.fail(
      new DotfilesError("The AI config export contains an invalid destination"),
    );
  const target = join(destination, file.path);
  yield* fs.makeDirectory(dirname(target), {
    recursive: true,
    mode: privateDirectoryMode,
  });
  const rule = Object.hasOwn(configRules, file.path)
    ? configRules[file.path]
    : undefined;
  const currentPath = join(home, file.path);
  const currentExists =
    rule && (rule.onlyIfCurrentExists || rule.preserveCurrent)
      ? yield* fs.exists(currentPath)
      : false;
  if (rule && (!rule.onlyIfCurrentExists || currentExists)) {
    const contents = yield* renderConfiguration(
      rule,
      currentPath,
      currentExists,
      exported,
      file.path,
    );
    yield* fs.writeFileString(target, contents, { mode: privateFileMode });
  } else yield* fs.copyFile(join(exported, file.path), target);
  yield* fs.chmod(target, file.private ? privateFileMode : publicFileMode);
  return { path: file.path, private: Boolean(file.private) };
});

export const prepareAiHome = Effect.fn("prepareAiHome")(function* (
  source: string,
  exported: string,
  destination: string,
  nativeCli: string,
  omp: string,
  farstep = join(source, "farstep/farstep"),
) {
  const fs = yield* FileSystem.FileSystem;
  const home = homedir();
  const manifestText = yield* fs.readFileString(join(exported, manifestFilename));
  const manifestJson = yield* Effect.try({
    try: () => JSON.parse(manifestText) as unknown,
    catch: (error) => new DotfilesError(`Invalid AI export manifest: ${error}`),
  });
  const manifest =
    yield* Schema.decodeUnknownEffect(ExportManifestSchema)(manifestJson);
  const files: PreparedAiManifest["files"] = [];
  const write = Effect.fn("writePreparedAiFile")(function* (
    path: string,
    contents: string,
  ) {
    const target = join(destination, path);
    yield* fs.makeDirectory(dirname(target), {
      recursive: true,
      mode: privateDirectoryMode,
    });
    yield* fs.writeFileString(target, contents, { mode: privateFileMode });
    files.push({ path, private: true });
  });
  for (const file of manifest.files) {
    files.push(yield* prepareExportedFile(file, exported, destination, home));
  }
  const links = {
    ".local/bin/ai": "tools/scripts/cli/ai.sh",
    ".local/bin/claude": "apps/claude/claude.ts",
    ".local/bin/codex": "apps/codex/codex.ts",
    ".local/bin/farstep": farstep,
    // Use the followed runtime without re-evaluating the source's standalone lock
    ".local/bin/omp": omp,
    ".local/bin/opencode": "apps/opencode/opencode.ts",
    ".omp/agent/lib/schema": "apps/omp/lib/schema",
    ".omp/agent/lib/sky": "farstep/sky",
    // Match the packaged Mac runtime's compact footer presentation
    ".omp/agent/extensions/compact": "apps/omp/extensions/compact",
    ".omp/agent/extensions/remote": "apps/omp/extensions/remote",
    ".omp/agent/extensions/skylight": "apps/omp/extensions/skylight",
    ".omp/agent/extensions/thinking": "apps/omp/extensions/thinking",
  };
  for (const [path, relative] of Object.entries(links)) {
    const target = join(destination, path);
    yield* fs.makeDirectory(dirname(target), {
      recursive: true,
      mode: privateDirectoryMode,
    });
    yield* fs.symlink(isAbsolute(relative) ? relative : join(source, relative), target);
    files.push({ path, private: false, type: "symlink" });
  }
  if (process.platform === "linux") {
    yield* write(
      ".config/environment.d/60-codex-cli.conf",
      `CODEX_CLI_PATH=${JSON.stringify(nativeCli)}\n`,
    );
    yield* write(
      ".config/systemd/user/ghidra-mcp.service",
      `[Unit]\nDescription=Ghidra MCP headless backend\n\n[Service]\nExecStart=${JSON.stringify(join(home, ".local/bin/ai"))} ghidra mcp httpd\nUMask=${privateServiceUmask}\nRestart=on-failure\nRestartSec=${ghidraRestartDelaySeconds}\n\n[Install]\nWantedBy=default.target\n`,
    );
  }
  const prepared = yield* Schema.decodeUnknownEffect(PreparedAiManifestSchema)({
    version: 1,
    platform: process.platform,
    files,
  });
  yield* fs.writeFileString(
    join(destination, manifestFilename),
    `${JSON.stringify(prepared)}\n`,
    { mode: privateFileMode },
  );
});
