import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  type CallToolResult,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MAX_RESPONSE_BYTES } from "../desktop/protocol";
import { boundRequest } from "./bounds";
import { assertDesktopHelper } from "./desktop";
import {
  type HelperIdentity,
  helperHandshakeSchema,
  structuredResult,
} from "./protocol";

const HELPER_ENVIRONMENT_KEYS = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
];

export interface NodeHelperConnection {
  identity: HelperIdentity;
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export async function connectNodeHelper(
  command: string,
  args = ["desktop", "connect"],
): Promise<NodeHelperConnection> {
  const env: Record<string, string> = {};
  for (const key of HELPER_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const transport = new StdioClientTransport({
    command,
    args,
    env,
    stderr: "ignore",
    maxBufferSize: MAX_RESPONSE_BYTES,
  });
  const client = new Client({ name: "omp-skylight", version: "1.0.0" });
  let closed = false;
  client.onclose = () => {
    closed = true;
  };
  async function close() {
    closed = true;
    await client.close();
  }
  async function call(
    name: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (closed) throw new Error("Helper channel is closed; reset and observe again");
    boundRequest(name, arguments_);
    try {
      // The SDK's return type also includes compatibility results, but this schema
      // makes request() validate and return a CallToolResult
      return (await client.callTool(
        { name, arguments: arguments_ },
        CallToolResultSchema,
        {
          timeout: 30_000,
          ...(signal ? { signal } : {}),
        },
      )) as CallToolResult;
    } catch (error) {
      await close();
      throw error;
    }
  }
  try {
    await client.connect(transport, { timeout: 30_000 });
    const identity = helperHandshakeSchema.parse(
      structuredResult(await call("helper.handshake", {})),
    );
    assertDesktopHelper(identity);
    return { identity, call, close };
  } catch (error) {
    await close();
    throw error;
  }
}
