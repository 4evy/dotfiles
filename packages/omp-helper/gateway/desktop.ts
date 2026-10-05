import { once } from "node:events";
import { lstat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { pipeline } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BoundedFrames } from "../../../dotfiles/dot_omp/agent/lib/helper/bounds";
import {
  UnzstdFrames,
  ZstdFrames,
} from "../../../dotfiles/dot_omp/agent/lib/helper/zstd";
import {
  MAX_DESKTOP_RESPONSE_BYTES,
  MAX_REQUEST_BYTES,
  PROTOCOL_MAJOR,
  paths,
  VERSION,
} from "./state";

async function privateSocket(): Promise<string> {
  const runtime = paths().runtime;
  const directory = await lstat(runtime);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new Error(
      "Desktop socket directory has unsafe ownership, type or permissions",
    );
  }
  const socket = join(runtime, "desktop.sock");
  const info = await lstat(socket);
  if (
    !info.isSocket() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("Desktop socket has unsafe ownership, type or permissions");
  }
  return socket;
}

class DesktopTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  #socket: Socket | undefined;
  #buffer = new ReadBuffer();

  async start(): Promise<void> {
    const socket = connect(await privateSocket());
    this.#socket = socket;
    const bounded = new BoundedFrames(
      MAX_DESKTOP_RESPONSE_BYTES,
      "Desktop response exceeded 46 MiB",
    );
    socket.on("error", (error) => this.onerror?.(error));
    socket.on("close", () => {
      bounded.destroy();
      this.onclose?.();
    });
    bounded.on("error", (error) => {
      this.onerror?.(error);
      socket.destroy();
    });
    bounded.on("data", (chunk: Buffer) => {
      try {
        this.#buffer.append(chunk);
        for (
          let message = this.#buffer.readMessage();
          message !== null;
          message = this.#buffer.readMessage()
        ) {
          this.onmessage?.(message);
        }
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
      }
    });
    socket.pipe(bounded);
    await once(socket, "connect");
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const encoded = serializeMessage(message);
    if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES)
      throw new Error("Desktop request exceeded 1 MiB");
    const socket = this.#socket;
    if (!socket || socket.destroyed) throw new Error("Desktop channel is closed");
    await new Promise<void>((resolve, reject) =>
      socket.write(encoded, (error) => (error ? reject(error) : resolve())),
    );
  }

  async close(): Promise<void> {
    this.#socket?.destroy();
    this.#buffer.clear();
  }
}

const healthSchema = z.strictObject({
  controlLeaseActive: z.boolean(),
  sessions: z.number().int().nonnegative(),
});
const handshakeSchema = z.object({
  protocolMajor: z.literal(PROTOCOL_MAJOR),
  version: z.string(),
  installationId: z.uuid(),
  platform: z.literal("linux"),
  capabilities: z.unknown(),
});

export async function desktopHealth(installationId: string, version?: string) {
  const client = new Client({ name: "omp-helper-management", version: VERSION });
  try {
    await client.connect(new DesktopTransport(), { timeout: 5_000 });
    const handshake = await client.callTool(
      { name: "helper.handshake", arguments: {} },
      undefined,
      { timeout: 5_000 },
    );
    if (handshake.isError) throw new Error("Desktop handshake failed");
    const identity = handshakeSchema.parse(handshake.structuredContent);
    if (
      identity.installationId !== installationId ||
      (version && identity.version !== version)
    ) {
      throw new Error(
        "Desktop installation identity or package version does not match",
      );
    }
    const result = await client.callTool(
      { name: "helper.health", arguments: {} },
      undefined,
      { timeout: 5_000 },
    );
    if (result.isError) throw new Error("Desktop health request failed");
    return healthSchema.parse(result.structuredContent);
  } finally {
    await client.close();
  }
}

export async function relayDesktop(compressed = false): Promise<void> {
  const socket = connect(await privateSocket());
  await once(socket, "connect");
  const completed = Promise.withResolvers<void>();
  let finished = false;
  function stop(error?: Error | null) {
    if (finished) return;
    finished = true;
    socket.destroy();
    process.stdin.destroy();
    if (error) completed.reject(error);
    else completed.resolve();
  }
  if (compressed) {
    pipeline(
      process.stdin,
      new UnzstdFrames(MAX_REQUEST_BYTES),
      new BoundedFrames(MAX_REQUEST_BYTES),
      socket,
      stop,
    );
    pipeline(
      socket,
      new BoundedFrames(MAX_DESKTOP_RESPONSE_BYTES),
      new ZstdFrames(MAX_DESKTOP_RESPONSE_BYTES),
      process.stdout,
      stop,
    );
  } else {
    pipeline(process.stdin, new BoundedFrames(MAX_REQUEST_BYTES), socket, stop);
    pipeline(
      socket,
      new BoundedFrames(MAX_DESKTOP_RESPONSE_BYTES),
      process.stdout,
      stop,
    );
  }
  await completed.promise;
}
