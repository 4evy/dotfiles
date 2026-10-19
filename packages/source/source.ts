#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";

export interface FilePin {
  url: string;
  narHash: string;
}

function sizeToken(size: number): Buffer {
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
export async function fileNarHash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for (const value of ["nix-archive-1", "(", "type", "regular", "contents"]) {
    digest.update(token(value));
  }
  const { size } = await stat(path);
  digest.update(sizeToken(size));
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  digest.update(Buffer.alloc((8 - (size % 8)) % 8));
  digest.update(token(")"));
  return `sha256-${digest.digest("base64")}`;
}

export async function downloadFile(pin: FilePin, destination: string): Promise<void> {
  if (new URL(pin.url).protocol !== "https:") {
    throw new Error("Source downloads require HTTPS");
  }
  const response = await fetch(pin.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Source download failed: ${response.status} ${pin.url}`);
  }
  try {
    // Callers own directory creation; Bun otherwise creates missing parents
    await Bun.write(destination, response, { createPath: false });
    const actual = await fileNarHash(destination);
    if (actual !== pin.narHash) {
      throw new Error(`NAR hash mismatch for ${pin.url}: ${actual}`);
    }
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [path, expected, ...extra] = Bun.argv.slice(2);
  if (!path || !expected || extra.length) {
    console.error("Usage: bun source.ts PATH NAR_HASH");
    process.exit(2);
  }
  const actual = await fileNarHash(path);
  if (actual !== expected) {
    console.error(`NAR hash mismatch for ${path}: ${actual}`);
    process.exitCode = 1;
  }
}
