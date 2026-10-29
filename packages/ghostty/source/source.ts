#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { DotfilesError } from "@dotfiles/core/errors";
import { download } from "@dotfiles/core/http";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Schema, Stream } from "effect";

export const FilePin = Schema.Struct({ url: Schema.String, narHash: Schema.String });
export type FilePin = typeof FilePin.Type;

function sizeToken(size: number | bigint): Buffer {
  const token = Buffer.alloc(8);
  token.writeBigUInt64LE(BigInt(size));
  return token;
}

function token(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([
    sizeToken(bytes.length),
    bytes,
    Buffer.alloc((8 - (bytes.length % 8)) % 8),
  ]);
}

// NAR framing describes a non-executable regular file, not its raw SHA256
export const fileNarHash = Effect.fn(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const digest = createHash("sha256");
  for (const value of ["nix-archive-1", "(", "type", "regular", "contents"])
    digest.update(token(value));
  const { size } = yield* fs.stat(path);
  digest.update(sizeToken(size));
  yield* Stream.runForEach(fs.stream(path), (chunk) =>
    Effect.sync(() => {
      digest.update(chunk);
    }),
  );
  digest.update(Buffer.alloc(Number((8n - (size % 8n)) % 8n)));
  digest.update(token(")"));
  return `sha256-${digest.digest("base64")}`;
});

export const downloadFile = Effect.fn(function* (pin: FilePin, destination: string) {
  const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(pin.url);
  if (url.protocol !== "https:")
    return yield* Effect.fail(new DotfilesError("Source downloads require HTTPS"));
  const fs = yield* FileSystem.FileSystem;
  yield* download(pin.url, (response) =>
    Effect.gen(function* () {
      // FileSystem's sink never creates missing parents, which callers own
      yield* Stream.run(response.stream, fs.sink(destination));
      const actual = yield* fileNarHash(destination);
      if (actual !== pin.narHash)
        return yield* Effect.fail(
          new DotfilesError(`NAR hash mismatch for ${pin.url}: ${actual}`),
        );
    }).pipe(
      Effect.onError(() => fs.remove(destination, { force: true }).pipe(Effect.orDie)),
    ),
  );
});

if (import.meta.main)
  runMain(
    Effect.gen(function* () {
      const [path, expected, ...extra] = Bun.argv.slice(2);
      if (!path || !expected || extra.length) {
        console.error("Usage: bun source.ts PATH NAR_HASH");
        process.exitCode = 2;
        return;
      }
      const actual = yield* fileNarHash(path);
      if (actual !== expected) {
        console.error(`NAR hash mismatch for ${path}: ${actual}`);
        process.exitCode = 1;
      }
    }),
  );
