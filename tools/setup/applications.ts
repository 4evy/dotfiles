#!/usr/bin/env bun
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DotfilesError } from "@dotfiles/core/errors";
import { writeIfChanged } from "@dotfiles/core/files";
import { runMain } from "@dotfiles/core/runtime";
import rustdeskOptions from "@dotfiles/repo/data/rustdesk/options";
import { Effect, FileSystem, Schema } from "effect";

const macOS = process.platform === "darwin";
const object = Schema.Record(Schema.String, Schema.Unknown);

// RustDesk options are strings, including numeric ports and empty flags
// Bun normalizes changed TOML and drops comments, semantic no-ops keep bytes
export const updateTomlOptions = Effect.fn(function* (
  path: string,
  values: Record<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(path);
  const original = exists ? yield* fs.readFileString(path) : "";
  const parsed = yield* Effect.try({
    try: () => Bun.TOML.parse(original),
    catch: (error) => new DotfilesError(`Invalid application TOML: ${error}`),
  });
  const config = yield* Schema.decodeUnknownEffect(object)(parsed);
  const options =
    config.options === undefined
      ? {}
      : yield* Schema.decodeUnknownEffect(object)(config.options);
  if (Object.entries(values).every(([key, value]) => options[key] === value)) return;
  const mode = exists ? (yield* fs.stat(path)).mode & 0o7777 : 0o600;
  const content = yield* Effect.try({
    try: () =>
      Bun.TOML.stringify({
        ...config,
        options: { ...options, ...values },
      }),
    catch: (error) => new DotfilesError(`Cannot serialize application TOML: ${error}`),
  });
  yield* writeIfChanged(path, content, mode);
});

const linkRustdesk = Effect.fn(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const link = join(home, ".local/bin/rustdesk");
  const target = "/Applications/RustDesk.app/Contents/MacOS/RustDesk";
  if (!(yield* fs.exists(target))) return;
  const state = yield* fs.lstat(link).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );
  if (state?.type === "SymbolicLink" && (yield* fs.readLink(link)) === target) return;
  yield* fs.makeDirectory(dirname(link), { recursive: true });
  yield* fs.remove(link, { force: true });
  yield* fs.symlink(target, link);
});

export const rustdesk = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = homedir();
  const directory = macOS
    ? join(home, "Library/Preferences/com.carriez.RustDesk")
    : join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "rustdesk");
  yield* fs.makeDirectory(directory, { recursive: true });
  const options: Record<string, string> = {
    ...rustdeskOptions.common,
    ...(!macOS ? rustdeskOptions.linux : {}),
  };
  yield* updateTomlOptions(join(directory, "RustDesk2.toml"), options);
  if (macOS) yield* linkRustdesk(home);
});

if (import.meta.main) {
  runMain(
    Effect.gen(function* () {
      const usage = "Usage: applications.ts rustdesk";
      const args = process.argv.slice(2);
      const command = args[0];
      if (args.length !== 1 || command === undefined)
        return yield* Effect.fail(new DotfilesError(usage));
      if (command === "-h" || command === "--help")
        yield* Effect.sync(() => console.log(usage));
      else if (command === "rustdesk") yield* rustdesk();
      else return yield* Effect.fail(new DotfilesError(usage));
    }),
  );
}
