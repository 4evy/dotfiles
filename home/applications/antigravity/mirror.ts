import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Schema } from "effect";

const ServerSchema = Schema.Struct({
  type: Schema.Literal("local"),
  command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  disabled: Schema.optionalKey(Schema.Boolean),
  timeout: Schema.optionalKey(
    Schema.Struct({
      catalog: Schema.optionalKey(Schema.Number),
      execution: Schema.optionalKey(Schema.Number),
    }),
  ),
});
const OpenCodeSchema = Schema.Struct({
  mcp: Schema.Struct({
    servers: Schema.Record(Schema.String, Schema.mutableKey(ServerSchema)),
  }),
});
const CodexSchema = Schema.Struct({
  mcp_servers: Schema.optionalKey(
    Schema.Struct({
      "1password": Schema.optionalKey(
        Schema.Struct({
          command: Schema.optionalKey(Schema.String),
          args: Schema.optionalKey(Schema.Array(Schema.String)),
          enabled: Schema.optionalKey(Schema.Boolean),
          startup_timeout_sec: Schema.optionalKey(Schema.Number),
          tool_timeout_sec: Schema.optionalKey(Schema.Number),
        }),
      ),
    }),
  ),
});
const CurrentSchema = Schema.StructWithRest(
  Schema.Struct({
    mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const parseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (error) => new DotfilesError(`Invalid MCP settings JSON: ${error}`),
  });

runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = process.env.HJEM_HOME_DIR || homedir();
    const source = yield* Schema.decodeUnknownEffect(OpenCodeSchema)(
      yield* parseJson(
        yield* fs.readFileString(join(home, ".config/opencode/opencode.json")),
      ),
    );
    const servers = source.mcp.servers;
    // 1Password's native MCP integration is configured by Codex, not OpenCode
    const codexFile = join(home, ".codex/config.toml");
    if (yield* fs.exists(codexFile)) {
      const text = yield* fs.readFileString(codexFile);
      const parsed = yield* Effect.try({
        try: () => Bun.TOML.parse(text),
        catch: (error) => new DotfilesError(`Invalid Codex MCP settings: ${error}`),
      });
      const codex = yield* Schema.decodeUnknownEffect(CodexSchema)(parsed);
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
        let [command, ...args] = server.command;
        if (name === "farstep_desktop" || name === "farstep_system") {
          args = [
            fileURLToPath(new URL("./mcp.ts", import.meta.url)),
            ...server.command,
          ];
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
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const original = yield* fs
      .readFileString(target)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
        ),
      );
    const current = yield* Schema.decodeUnknownEffect(CurrentSchema)(
      original.trim() ? yield* parseJson(original) : {},
    );
    const contents = `${JSON.stringify(
      {
        ...current,
        mcpServers: { ...current.mcpServers, ...managed },
      },
      null,
      2,
    )}\n`;
    if (contents !== original)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* fs.makeTempDirectoryScoped({
            directory,
            prefix: ".dotfiles-mcp-",
          });
          const staging = join(temporary, "mcp_config.json");
          yield* fs.writeFileString(staging, contents, { mode: 0o600 });
          const latest = (yield* fs.exists(target))
            ? yield* fs.readFileString(target)
            : "";
          if (latest !== original)
            return yield* Effect.fail(
              new DotfilesError(
                "Antigravity MCP settings changed during apply, run just apply again",
              ),
            );
          yield* fs.rename(staging, target);
        }),
      );
    yield* fs.chmod(target, 0o600);
  }),
);
