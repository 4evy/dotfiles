import type { AgentToolResult, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isSameMachineSSH } from "@oh-my-pi/pi-coding-agent/ssh/transfer-compression";
import { Serial } from "@oh-my-pi/pi-utils";
import {
  authorizeRequestSchema,
  authorizeResponseSchema,
  captureRequestSchema,
  type DesktopInputRequest,
  desktopInputSchema,
  inputResponseSchema,
  inspectResponseSchema,
  openRequestSchema,
  openResponseSchema,
  releaseRequestSchema,
  simpleResponseSchema,
  workspaceReleaseRequestSchema,
} from "../../lib/desktop/protocol";
import { connectHelper, type HelperConnection } from "../../lib/helper/bun";
import { assertDesktopHelper, parseCapture } from "../../lib/helper/desktop";
import { structuredResult } from "../../lib/helper/protocol";
import { remoteArgv } from "./connections/command";
import type { Connection } from "./connections/types";
import { owner } from "./jobs/records";

export interface DesktopInput {
  action: "inspect" | "open" | "authorize" | "release" | "release-workspace";
  uri?: string | undefined;
  source?: "monitor" | "window" | undefined;
  outputName?: string | undefined;
  sessionId?: string | undefined;
  workspaceId?: string | undefined;
  timeout?: number | undefined;
}
export interface ScreenshotInput {
  target?: "screen" | "window" | undefined;
  sessionId?: string | undefined;
  timeout?: number | undefined;
}
export interface DesktopOperations {
  desktop(
    connection: Connection,
    input: DesktopInput,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
  screenshot(
    connection: Connection,
    input: ScreenshotInput,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
  input(
    connection: Connection,
    input: DesktopInputRequest,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
  close(): Promise<void>;
}
interface Channel {
  client: Promise<HelperConnection>;
  serial: Serial;
  sessionId?: string;
}
const command = `exec "\${XDG_DATA_HOME:-$HOME/.local/share}/omp-helper/current/bin/omp-helper" desktop connect`;

function present(
  metadata: Record<string, unknown> & { status: "ok" | "error" },
  image?: { type: "image"; data: string; mimeType: string },
): AgentToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(metadata, null, 2) },
      ...(image ? [image] : []),
    ],
    details: metadata,
    ...(metadata.status === "error" ? { isError: true } : {}),
  };
}

const DEFAULT_DESKTOP_TIMEOUT = 30;

type DesktopCall = <T>(
  method: string,
  args: Record<string, unknown>,
  schema: { parse(value: unknown): T },
) => Promise<T>;
type DesktopAction = (
  input: DesktopInput,
  channel: Channel,
  call: DesktopCall,
) => Promise<AgentToolResult>;

const DESKTOP_ACTIONS = {
  inspect: async (_input, _channel, call) =>
    present(await call("desktop.inspect", {}, inspectResponseSchema)),
  open: async (input, _channel, call) => {
    const capabilities = await call("desktop.inspect", {}, inspectResponseSchema);
    if (capabilities.status === "error") return present(capabilities);
    const opener = capabilities.operations.find(
      (operation) => operation.operation === "open",
    );
    if (!opener?.available || opener.backend !== "gnome-mutter-workspace")
      return present({
        status: "error",
        code: "prerequisite",
        message:
          opener?.reason ??
          "Upgrade the Linux helper and activate its GNOME workspace adapter before opening a GUI",
      });
    return present(
      await call(
        "desktop.open",
        openRequestSchema.parse({ uri: input.uri }),
        openResponseSchema,
      ),
    );
  },
  authorize: async (input, channel, call) => {
    const result = await call(
      "desktop.authorize",
      authorizeRequestSchema.parse({
        source: input.source ?? "monitor",
        ...(input.outputName ? { outputName: input.outputName } : {}),
      }),
      authorizeResponseSchema,
    );
    if (result.status === "ok") channel.sessionId = result.sessionId;
    return present(result);
  },
  release: async (input, channel, call) => {
    const result = await call(
      "desktop.release",
      releaseRequestSchema.parse({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }),
      simpleResponseSchema,
    );
    if (result.status === "ok") delete channel.sessionId;
    return present(result);
  },
  "release-workspace": async (input, _channel, call) =>
    present(
      await call(
        "desktop.workspace.release",
        workspaceReleaseRequestSchema.parse({ workspaceId: input.workspaceId }),
        simpleResponseSchema,
      ),
    ),
} satisfies Record<DesktopInput["action"], DesktopAction>;

export function createDesktop(): DesktopOperations {
  const channels = new Map<string, Channel>();
  let generation = 0;
  async function get(
    connection: Connection,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    if (connection.info.os !== "linux")
      throw new Error("Remote desktop helper supports Linux Wayland only");
    const key = JSON.stringify([connection.target, connection.controlPath, owner(ctx)]);
    let channel = channels.get(key);
    if (!channel) {
      const openingGeneration = generation;
      const compressed = !(await isSameMachineSSH(connection.target, {
        controlPath: connection.controlPath,
        ...(signal ? { signal } : {}),
      }));
      const args = await remoteArgv(
        connection,
        `${command}${compressed ? " --wire-codec=zstd" : ""}`,
        false,
      );
      signal?.throwIfAborted();
      if (generation !== openingGeneration)
        throw new Error("Desktop session changed while connecting");
      channel = channels.get(key);
      if (!channel) {
        const fresh: Channel = {
          serial: new Serial(),
          client: connectHelper(
            "remote-desktop",
            { command: "ssh", args },
            {
              ...(signal ? { signal } : {}),
              ...(compressed ? { wireCodec: "zstd" as const } : {}),
              onClose: () => {
                if (channels.get(key) === fresh) channels.delete(key);
              },
            },
          ),
        };
        fresh.client.catch(() => {
          if (channels.get(key) === fresh) channels.delete(key);
        });
        channels.set(key, fresh);
        channel = fresh;
      }
    }
    return channel;
  }
  async function run(
    connection: Connection,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    work: (client: HelperConnection, channel: Channel) => Promise<AgentToolResult>,
  ) {
    const channel = await get(connection, ctx, signal);
    return channel.serial.run(async () => {
      signal?.throwIfAborted();
      const client = await channel.client;
      try {
        assertDesktopHelper(client.identity);
        return await work(client, channel);
      } catch (error) {
        await client.close();
        throw error;
      }
    });
  }
  return {
    async close() {
      generation++;
      const pending = [...channels.values()];
      channels.clear();
      await Promise.all(
        pending.map(async (channel) => {
          const client = await channel.client.catch(() => undefined);
          await client?.close();
        }),
      );
    },
    desktop(connection, input, ctx, signal) {
      return run(connection, ctx, signal, async (client, channel) => {
        const timeout = (input.timeout ?? DEFAULT_DESKTOP_TIMEOUT) * 1000;
        const call: DesktopCall = async (method, args, schema) =>
          schema.parse(
            structuredResult(await client.call(method, args, signal, timeout)),
          );
        return DESKTOP_ACTIONS[input.action](input, channel, call);
      });
    },
    screenshot(connection, input, ctx, signal) {
      return run(connection, ctx, signal, async (client, channel) => {
        const sessionId = input.sessionId ?? channel.sessionId;
        const args = captureRequestSchema.parse({
          ...(sessionId ? { sessionId } : {}),
          ...(input.target
            ? { source: input.target === "window" ? "window" : "monitor" }
            : {}),
        });
        const { metadata, image } = parseCapture(
          await client.call(
            "desktop.capture",
            args,
            signal,
            (input.timeout ?? DEFAULT_DESKTOP_TIMEOUT) * 1000,
          ),
        );
        if (metadata.status === "ok") channel.sessionId = metadata.frame.sessionId;
        return present(metadata, image);
      });
    },
    input(connection, input, ctx, signal) {
      return run(connection, ctx, signal, async (client) =>
        present(
          inputResponseSchema.parse(
            structuredResult(
              await client.call(
                "desktop.input",
                desktopInputSchema.parse(input),
                signal,
              ),
            ),
          ),
        ),
      );
    },
  };
}
