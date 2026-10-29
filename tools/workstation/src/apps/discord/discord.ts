import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { isExecutable, writeJson } from "@dotfiles/core/files";
import { configHome } from "@dotfiles/core/paths";
import { shellWords } from "@dotfiles/core/shell";
import { Effect, FileSystem, Option, Schema, SchemaTransformation } from "effect";

const truthy = [true, 1, "1", "on", "true", "yes", "t", "y"] as const;
const falsy = [false, 0, "0", "off", "false", "no", "f", "n"] as const;
const coercibleBoolean = Schema.Unknown.pipe(
  Schema.decode<typeof Schema.Unknown>(
    SchemaTransformation.transform<unknown, unknown>({
      decode: (value) => (typeof value === "string" ? value.toLowerCase() : value),
      encode: (value) => value,
    }),
  ),
  Schema.decodeTo(Schema.Literals([...truthy, ...falsy])),
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (value) => truthy.some((item) => item === value),
      encode: (value) => value,
    }),
  ),
);
const switches = Schema.StructWithRest(
  Schema.Struct({
    force_high_performance_gpu: coercibleBoolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const settingsSchema = Schema.StructWithRest(
  Schema.Struct({
    enableHardwareAcceleration: coercibleBoolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
    ),
    DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING:
      coercibleBoolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
    chromiumSwitches: Schema.Unknown.pipe(
      Schema.decode<typeof Schema.Unknown>(
        SchemaTransformation.transform<unknown, unknown>({
          decode: (value) =>
            typeof value === "object" && value !== null && !Array.isArray(value)
              ? value
              : {},
          encode: (value) => value,
        }),
      ),
      Schema.decodeTo(switches),
      Schema.withDecodingDefault(Effect.succeed({})),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export const configureGPU = Effect.fn("configureGPU")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(directory, "settings.json");
  const input = (yield* fs.exists(path)) ? yield* fs.readFileString(path) : "{}";
  const settings = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(settingsSchema),
  )(input).pipe(
    Effect.mapError(() => new DotfilesError(`Invalid Discord settings JSON: ${path}`)),
  );
  yield* writeJson(
    path,
    {
      ...settings,
      enableHardwareAcceleration: true,
      DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING: true,
      chromiumSwitches: {
        ...settings.chromiumSwitches,
        force_high_performance_gpu: true,
      },
    },
    0o600,
  );
});

export const discord = Effect.fn("discord")(function* (args: string[]) {
  if (process.platform === "darwin")
    return yield* Effect.fail(
      new DotfilesError("Discord on macOS is managed by Nixcord"),
    );
  const fs = yield* FileSystem.FileSystem;
  const config = yield* configHome();
  yield* configureGPU(join(config, "discord"));
  if (args.includes("--configure-only")) return 0;
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
  const executable = yield* Effect.findFirst(
    [
      "/run/current-system/sw/bin/Discord",
      join(state, "hjem/standalone/current-profile/bin/Discord"),
      join(homedir(), ".nix-profile/bin/Discord"),
    ],
    isExecutable,
  );
  if (Option.isNone(executable))
    return yield* Effect.fail(
      new DotfilesError("Nix-managed Discord was not found, run just nix"),
    );
  const path = join(config, "discord-flags.conf");
  const text = (yield* fs.exists(path)) ? yield* fs.readFileString(path) : "";
  const flags = yield* Effect.try({
    try: () => shellWords(text),
    catch: (error) =>
      error instanceof DotfilesError ? error : new DotfilesError(String(error)),
  });
  return (yield* run([executable.value, ...flags, ...args], { check: false })).code;
});
