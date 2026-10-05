import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  callTool,
  connectToServer,
  disconnectServer,
} from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { Serial } from "@oh-my-pi/pi-utils";
import { installLinuxService } from "./linux";
import { LINUX } from "./paths";
import { runtimeServer } from "./server";

export function createRuntime() {
  let connection: Promise<MCPServerConnection> | undefined;
  let sessionDirectory: string | undefined;
  const serial = new Serial();

  async function close() {
    const pending = connection;
    connection = undefined;
    try {
      const client = await pending?.catch(() => undefined);
      if (client) {
        try {
          await releaseInput(client);
        } finally {
          await disconnectServer(client);
        }
      }
    } finally {
      if (sessionDirectory) {
        await rm(sessionDirectory, { recursive: true, force: true });
        sessionDirectory = undefined;
      }
    }
  }

  function connect(ctx: ExtensionContext, signal?: AbortSignal) {
    connection ??= open(ctx, signal);
    return connection;
  }

  async function releaseInput(client: MCPServerConnection, signal?: AbortSignal) {
    if (!sessionDirectory) return;
    const result = await callTool(
      client,
      "js",
      {
        code: 'await nodeRepl.rpc("sky", {type: "release_input"});',
        timeout_ms: 5000,
      },
      {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(7000)])
          : AbortSignal.timeout(7000),
      },
    );
    if (result.isError) {
      throw new Error(
        `Linux input cleanup failed: ${result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")}`,
      );
    }
  }

  async function open(ctx: ExtensionContext, signal?: AbortSignal) {
    const server = runtimeServer(ctx);
    if (LINUX) {
      if (!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== "wayland") {
        throw new Error("Linux Skylight supports Wayland only; X11 is unsupported");
      }
      sessionDirectory = await mkdtemp(join(tmpdir(), "omp-skylight-"));
      await installLinuxService(server.env, sessionDirectory);
    }
    return connectToServer("skylight", server, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  }

  return { serial, close, connect, releaseInput };
}
