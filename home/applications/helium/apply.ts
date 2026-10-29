#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { download } from "@dotfiles/core/http";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Schema } from "effect";

const macOS = process.platform === "darwin";

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
        "https://github.com/4evy.png?size=256",
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
          "256x256^",
          "-gravity",
          "center",
          "-extent",
          "256x256",
          `PNG:${png}`,
        ],
        { stderr: "inherit" },
      );
      const target = join(profile, "Custom Avatar Picture.png");
      const generated = yield* fs.readFile(png);
      const current = (yield* fs.exists(target))
        ? yield* fs.readFile(target)
        : undefined;
      if (
        !current ||
        current.length !== generated.length ||
        !current.every((byte, index) => byte === generated[index])
      )
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
  const json = yield* Effect.try({
    try: () => JSON.parse(decrypted.stdout) as unknown,
    catch: (error) =>
      new DotfilesError(`Invalid private Helium configuration: ${error}`),
  });
  const privateConfig = yield* Schema.decodeUnknownEffect(PrivateConfigSchema)(json);
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

export const helium = Effect.fn("helium")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = resolve(import.meta.dir, "../../..");
  const configPath = join(import.meta.dir, "config.toml");
  const contents = yield* fs.readFileString(configPath);
  const parsed = yield* Effect.try({
    try: () => Bun.TOML.parse(contents),
    catch: (error) =>
      new DotfilesError(`Invalid Helium wrapper configuration: ${error}`),
  });
  const config = (yield* Schema.decodeUnknownEffect(WrapperConfigSchema)(parsed))
    .browser;
  const platform = macOS ? "macos" : "linux";
  const home = homedir();
  const variables = {
    home,
    config_home: process.env.XDG_CONFIG_HOME || join(home, ".config"),
    data_home: process.env.XDG_DATA_HOME || join(home, ".local/share"),
  };
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
  const applyProfile = running.code === 1;
  const cache = join(
    process.env.XDG_CACHE_HOME ?? join(home, ".cache"),
    "dotfiles/helium",
  );
  yield* fs.makeDirectory(cache, { recursive: true });
  if (applyProfile) {
    let profile = config.paths[platform]?.profile_dir;
    if (!profile)
      return yield* Effect.fail(
        new DotfilesError(`Missing Helium ${platform} profile path`),
      );
    for (const [key, value] of Object.entries(variables))
      profile = profile.replaceAll(`\${${key}}`, value);
    yield* fs.makeDirectory(profile, { recursive: true });
    yield* avatar(profile, cache);
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
      const args = Bun.argv.slice(2);
      const usage = "Usage: bun home/applications/helium/apply.ts";
      if (args.length === 1 && (args[0] === "-h" || args[0] === "--help"))
        console.log(usage);
      else if (args.length) return yield* Effect.fail(new DotfilesError(usage));
      else yield* helium();
    }),
  );
