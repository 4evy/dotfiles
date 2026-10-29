#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { isExecutable } from "@dotfiles/core/files";
import { download } from "@dotfiles/core/http";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Schema } from "effect";

const releases =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";
const manifestSchema = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  sha512: Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/)),
});

export const installAntigravity = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (process.platform !== "darwin" && process.platform !== "linux")
    return yield* Effect.fail(
      new DotfilesError(`Unsupported Antigravity platform: ${process.platform}`),
    );
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  if (arch !== "amd64" && arch !== "arm64")
    return yield* Effect.fail(
      new DotfilesError(`Unsupported Antigravity architecture: ${process.arch}`),
    );

  // Keep existing, self-updating Apps, including versions newer than the cask
  if (
    process.platform === "darwin" &&
    !(yield* fs.exists("/Applications/Antigravity.app"))
  )
    yield* run(["brew", "install", "--cask", "antigravity"]);

  const bin = join(homedir(), ".local/bin");
  const target = join(bin, "agy");
  const installed = yield* fs.lstat(target).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );
  if (installed) {
    if (installed.type !== "File")
      return yield* Effect.fail(
        new DotfilesError(`Refusing to replace an existing non-file at ${target}`),
      );
    if (!(yield* isExecutable(target)))
      return yield* Effect.fail(
        new DotfilesError(`Antigravity CLI is not executable: ${target}`),
      );
    yield* Effect.sync(() =>
      console.log(`Antigravity CLI already installed at ${target}, using self-updates`),
    );
    return;
  }

  yield* fs.makeDirectory(bin, { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const workspace = yield* fs.makeTempDirectoryScoped({
        directory: bin,
        prefix: ".antigravity-",
      });
      const platform = `${process.platform}_${arch}`;
      const manifest = yield* download(
        `${releases}/manifests/${platform}.json`,
        (response) =>
          Effect.flatMap(response.json, Schema.decodeUnknownEffect(manifestSchema)),
      );
      const payload = join(workspace, "payload");
      const bytes = new Uint8Array(
        yield* download(manifest.url, (response) => response.arrayBuffer),
      );
      if (createHash("sha512").update(bytes).digest("hex") !== manifest.sha512)
        return yield* Effect.fail(
          new DotfilesError("Antigravity CLI checksum mismatch"),
        );
      yield* fs.writeFile(payload, bytes);

      const archive = new URL(manifest.url).pathname.endsWith(".tar.gz");
      const binary = archive ? join(workspace, "antigravity") : payload;
      if (archive) yield* run(["tar", "-xzf", payload, "-C", workspace, "antigravity"]);
      if ((yield* fs.lstat(binary)).type !== "File")
        return yield* Effect.fail(
          new DotfilesError("Antigravity CLI payload is not a regular file"),
        );
      yield* fs.chmod(binary, 0o755);

      // The official bootstrapper runs `agy install`, which edits shell profiles
      // Install its verified payload directly, leaving PATH and aliases to dotfiles
      // A hard link publishes atomically without replacing a concurrent installation
      yield* fs.link(binary, target);
      yield* Effect.sync(() => console.log(`Installed Antigravity CLI at ${target}`));
    }),
  );
});

if (import.meta.main) {
  runMain(
    Effect.gen(function* () {
      const args = Bun.argv.slice(2);
      if (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))
        yield* Effect.sync(() => console.log("Usage: antigravity.ts"));
      else if (args.length)
        return yield* Effect.fail(new DotfilesError("Usage: antigravity.ts"));
      else yield* installAntigravity();
    }),
  );
}
