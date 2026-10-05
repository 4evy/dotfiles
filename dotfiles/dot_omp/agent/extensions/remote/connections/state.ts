import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildSshTarget } from "@oh-my-pi/pi-coding-agent/ssh/utils";
import { ptree } from "@oh-my-pi/pi-utils";
import { z } from "zod";
import { helperStatusSchema } from "../helper/helper";
import type { Connection, ConnectionState } from "./types";

const CONNECTIONS_ENTRY = "remote-connections";
const connectionSchema = z.object({
  id: z.string().min(1),
  target: z.object({
    name: z.string().min(1),
    host: z.string().min(1),
    username: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    keyPath: z.string().optional(),
    compat: z.boolean().optional(),
  }),
  controlPath: z.string().min(1),
  info: z.object({
    version: z.number().int(),
    os: z.enum(["windows", "linux", "macos", "unknown"]),
    shell: z.enum(["cmd", "powershell", "bash", "zsh", "sh", "unknown"]),
    transferShell: z.enum(["sh", "bash", "zsh"]).optional(),
    compatShell: z.enum(["bash", "sh"]).optional(),
    compatEnabled: z.boolean(),
  }),
  home: z.string().min(1),
  cwd: z.string().min(1),
  bash: z.string().min(1),
  zsh: z.string().min(1).optional(),
  timeout: z.string().optional(),
  arch: z.string(),
  fileRoot: z.string(),
  helper: helperStatusSchema.optional(),
});
const connectionsSchema = z.array(connectionSchema);

export function createConnections(api: ExtensionAPI) {
  const connections = new Map<string, Connection>();

  function selected(id: string): Connection {
    const connection = connections.get(id);
    if (!connection) {
      throw new Error(`Unknown connection '${id}'; use remote_connect first`);
    }
    return connection;
  }

  const restore = (ctx: ExtensionContext) => {
    connections.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== CONNECTIONS_ENTRY) continue;
      const parsed = connectionsSchema.safeParse(entry.data);
      if (!parsed.success) continue;
      connections.clear();
      for (const connection of parsed.data) {
        const restored = connection as Connection;
        connections.set(restored.id, restored);
      }
    }
  };
  function save(connection: Connection) {
    connections.set(connection.id, connection);
    api.appendEntry(CONNECTIONS_ENTRY, [...connections.values()]);
  }
  return { connections, selected, save, restore };
}
export type Connections = ReturnType<typeof createConnections>;

export async function connectionState(
  connection: Connection,
  signal?: AbortSignal,
): Promise<ConnectionState> {
  signal?.throwIfAborted();
  const result = await ptree.exec(
    [
      "ssh",
      "-O",
      "check",
      "-S",
      connection.controlPath,
      buildSshTarget(connection.target.username, connection.target.host),
    ],
    {
      timeout: 10_000,
      ...(signal ? { signal } : {}),
      allowNonZero: true,
      allowAbort: true,
    },
  );
  signal?.throwIfAborted();
  const match = /Master running \(pid=(\d+)\)/u.exec(result.stderr);
  return {
    controlPath: connection.controlPath,
    active: result.ok && result.exitCode === 0,
    ...(match ? { masterPid: Number(match[1]) } : {}),
  };
}
