#!/usr/bin/env bun
import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { download } from "@dotfiles/core/http";
import { runMain } from "@dotfiles/core/runtime";
import { runParser } from "@optique/core/facade";
import { constant } from "@optique/core/primitives";
import { Effect, FileSystem, Schema } from "effect";

const macOS = process.platform === "darwin";
const AVATAR_SIZE_PX = 256;
const AVATAR_GEOMETRY = `${AVATAR_SIZE_PX}x${AVATAR_SIZE_PX}`;

// Validate only the fields consumed here, leaving Tweezle's schema upstream
const WrapperConfigSchema = Schema.Struct({
  browser: Schema.Struct({
    paths: Schema.Record(Schema.String, Schema.Struct({ profile_dir: Schema.String })),
  }),
});
const PrivateConfigSchema = Schema.Struct({
  "chromium-cookie-allowed-for-urls": Schema.optionalKey(
    Schema.NullOr(Schema.Array(Schema.String)),
  ),
});

const avatar = Effect.fn("heliumAvatar")(function* (profile: string, cache: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory: cache,
        prefix: "avatar.",
      });
      const original = join(temporary, "avatar");
      const png = join(temporary, "avatar.png");
      const bytes = yield* download(
        `https://github.com/4evy.png?size=${AVATAR_SIZE_PX}`,
        (response) => response.arrayBuffer,
      );
      yield* fs.writeFile(original, new Uint8Array(bytes));
      yield* run(
        [
          "magick",
          original,
          "-auto-orient",
          "-strip",
          "-resize",
          `${AVATAR_GEOMETRY}^`,
          "-gravity",
          "center",
          "-extent",
          AVATAR_GEOMETRY,
          `PNG:${png}`,
        ],
        { stderr: "inherit" },
      );
      const target = join(profile, "Custom Avatar Picture.png");
      const generated = yield* fs.readFile(png);
      const current = (yield* fs.exists(target))
        ? yield* fs.readFile(target)
        : undefined;
      if (!current || Buffer.compare(current, generated) !== 0)
        yield* fs.copyFile(png, target);
    }),
  );
});

const privatePayload = Effect.fn("heliumPrivatePayload")(function* (root: string) {
  const env = { ...process.env };
  if (macOS) env.SOPS_AGE_KEY_CMD = join(root, "home/files/.local/lib/sops/sops.sh");
  const decrypted = yield* run(
    ["sops", "decrypt", "--output-type", "json", join(root, "secrets/secrets.yaml")],
    { env, capture: true, stderr: "inherit" },
  );
  const privateConfig = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(PrivateConfigSchema),
  )(decrypted.stdout);
  const payload: Record<string, unknown> = {};
  const allowlist = privateConfig["chromium-cookie-allowed-for-urls"] ?? [];
  if (allowlist.length) payload.cookie_allowlist = allowlist;
  if (process.env.OP_ACCOUNT) {
    const token = yield* run(["op", "read", "op://Private/Refined GitHub/token"], {
      capture: true,
      check: false,
      stderr: "ignore",
      stdin: "ignore",
    });
    const value = token.stdout.trim();
    if (token.code === 0 && value)
      payload.extension_values = { "refined-github-personal-token": value };
  }
  return payload;
});

const wrapperConfig = Effect.fn("heliumWrapperConfig")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(path);
  const parsed = yield* Effect.try({
    try: () => Bun.TOML.parse(contents),
    catch: (error) =>
      new DotfilesError(`Invalid Helium wrapper configuration: ${error}`),
  });
  return (yield* Schema.decodeUnknownEffect(WrapperConfigSchema)(parsed)).browser;
});

const profileAvailable = Effect.fn("heliumProfileAvailable")(function* () {
  const pattern = macOS
    ? "^/Applications/(Nix Apps/)?Helium[.]app/Contents/MacOS/Helium([[:space:]]|$)"
    : "helium";
  const running = yield* run(["pgrep", macOS ? "-f" : "-x", pattern], {
    check: false,
    outputMode: "discard",
    stderr: "inherit",
    stdin: "ignore",
  });
  if (running.code !== 0 && running.code !== 1)
    return yield* Effect.fail(new DotfilesError("Could not inspect Helium processes"));
  return running.code === 1;
});

const prepareProfile = Effect.fn("heliumPrepareProfile")(function* (
  config: (typeof WrapperConfigSchema.Type)["browser"],
  platform: string,
  variables: Record<string, string>,
  cache: string,
) {
  const fs = yield* FileSystem.FileSystem;
  let profile = config.paths[platform]?.profile_dir;
  if (!profile)
    return yield* Effect.fail(
      new DotfilesError(`Missing Helium ${platform} profile path`),
    );
  for (const [key, value] of Object.entries(variables))
    profile = profile.replaceAll(`\${${key}}`, value);
  yield* fs.makeDirectory(profile, { recursive: true });
  yield* avatar(profile, cache);
});

export const helium = Effect.fn("helium")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = resolve(import.meta.dir, "../../..");
  const configPath = join(import.meta.dir, "config.toml");
  const config = yield* wrapperConfig(configPath);
  const platform = macOS ? "macos" : "linux";
  const home = homedir();
  const variables = {
    home,
    config_home: process.env.XDG_CONFIG_HOME || join(home, ".config"),
    data_home: process.env.XDG_DATA_HOME || join(home, ".local/share"),
  };
  const applyProfile = yield* profileAvailable();
  const cache = join(
    process.env.XDG_CACHE_HOME ?? join(home, ".cache"),
    "dotfiles/helium",
  );
  yield* fs.makeDirectory(cache, { recursive: true });
  if (applyProfile) {
    yield* prepareProfile(config, platform, variables, cache);
  } else {
    // Launcher updates are safe while Chromium owns its profile
    console.log("Helium is running, refreshing launchers without profile changes");
  }
  const input = applyProfile ? JSON.stringify(yield* privatePayload(root)) : undefined;
  yield* run(
    [
      "tweezle",
      "apply",
      configPath,
      "--platform",
      platform,
      "--install-dir",
      cache,
      "--bin-dir",
      join(home, ".local/bin"),
      ...(applyProfile ? ["--input", "-"] : ["--no-profile"]),
    ],
    {
      ...(input === undefined ? {} : { input }),
      outputMode: "discard",
      stderr: "inherit",
    },
  );
});

if (import.meta.main)
  runMain(
    Effect.gen(function* () {
      runParser(
        constant(undefined),
        "home/applications/helium/apply.ts",
        Bun.argv.slice(2),
        {
          help: { option: { names: ["-h", "--help"] }, onShow: process.exit },
          onError: process.exit,
        },
      );
      yield* helium();
    }),
  );
