import { fileURLToPath } from "node:url";
import {
  callTool,
  connectToServer,
  disconnectServer,
} from "@oh-my-pi/pi-coding-agent/mcp/client";
import type {
  MCPStdioServerConfig,
  MCPToolCallResult,
} from "@oh-my-pi/pi-coding-agent/mcp/types";
import { boundRequest } from "./bounds";
import {
  type HelperIdentity,
  helperHandshakeSchema,
  structuredResult,
} from "./protocol";

export interface HelperConnection {
  identity: HelperIdentity;
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<MCPToolCallResult>;
  close(): Promise<void>;
}

export async function connectHelper(
  name: string,
  config: MCPStdioServerConfig,
  options: {
    signal?: AbortSignal;
    wireCodec?: "zstd";
    onNotification?: (method: string, params: unknown) => void;
    onClose?: () => void;
  } = {},
): Promise<HelperConnection> {
  const connection = await connectToServer(
    name,
    {
      ...config,
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./relay.ts", import.meta.url)),
        ...(options.wireCodec ? ["--wire-codec=zstd"] : []),
        config.command,
        ...(config.args ?? []),
      ],
      timeout: 0,
    },
    {
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
      ...(options.onNotification ? { onNotification: options.onNotification } : {}),
    },
  );
  let closed = false;
  connection.transport.onClose = () => {
    closed = true;
    options.onClose?.();
  };
  async function close() {
    if (closed) return;
    closed = true;
    try {
      await disconnectServer(connection);
    } finally {
      options.onClose?.();
    }
  }
  async function call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = config.timeout ?? 30_000,
  ) {
    if (closed) throw new Error("Helper channel is closed");
    boundRequest(tool, args);
    const deadline = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const combined =
      signal && deadline ? AbortSignal.any([signal, deadline]) : (signal ?? deadline);
    try {
      return await callTool(
        connection,
        tool,
        args,
        combined ? { signal: combined } : {},
      );
    } catch (error) {
      // Cancellation is not revocation: EOF also releases the native input lease
      await close();
      throw error;
    }
  }
  try {
    const identity = helperHandshakeSchema.parse(
      structuredResult(await call("helper.handshake", {}, options.signal, 30_000)),
    );
    return { identity, call, close };
  } catch (error) {
    await close();
    throw error;
  }
}
