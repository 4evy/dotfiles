import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
  DAEMON_PTY_COLUMNS,
  DAEMON_PTY_ROWS,
  parseDaemonSpec,
  parseDaemonTerminalSize,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { resolveRemoteCwd } from "../../connections/target";
import type { Connection } from "../../connections/types";
import type { JobSession } from "../session";
import { commandShell } from "../shell";
import type { LaunchRecord, RunInput } from "../types";
import { regex, seconds, string } from "../validation";

export async function prepareLaunch(
  session: JobSession,
  connection: Connection,
  input: RunInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
) {
  if (!string(input.command))
    throw new Error("command must be nonempty and contain no NUL");
  const shell = commandShell(connection, input);
  seconds(input.timeout, 0, "timeout");
  const waitMs = seconds(input.waitSeconds, input.ready ? 30 : 10, "waitSeconds");
  regex(input.ready);
  const pty = input.pty ?? true;
  if (!pty && (input.columns !== undefined || input.rows !== undefined))
    throw new Error("Terminal dimensions require pty:true");
  const size = pty
    ? parseDaemonTerminalSize({
        columns: input.columns ?? DAEMON_PTY_COLUMNS,
        rows: input.rows ?? DAEMON_PTY_ROWS,
      })
    : undefined;
  signal?.throwIfAborted();
  const scope = session.current(ctx);
  const client = await session.client(scope, connection);
  const token = randomUUID().replaceAll("-", "");
  const suffix =
    (input.name ?? "job").replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 24) || "job";
  const name = `remote-${token.slice(0, 16)}-${suffix}`;
  const cwd = resolveRemoteCwd(connection, input.cwd);
  const originalSpec = parseDaemonSpec({
    name,
    application: shell.application,
    args: shell.args,
    env: client.env,
    cwd,
    pty,
    ...(size ? { terminalSize: size } : {}),
    restart: "no",
    persist: input.lifetime === "persist",
    detached: false,
    ...(input.ready ? { ready: { log: input.ready, timeoutMs: waitMs } } : {}),
  });
  const spec = await client.prepareStart(
    {
      operation: {
        op: "start",
        spec: originalSpec,
        owner: scope.owner,
        replace: false,
      },
      deadlineSeconds: input.timeout ?? 0,
    },
    signal,
  );
  signal?.throwIfAborted();
  const intent: LaunchRecord = {
    version: 2,
    kind: "launch",
    name,
    owner: scope.owner,
    projectDir: scope.projectDir,
    scopeId: scope.scopeId,
    installationId: client.installationId,
    spec,
    connectionId: connection.id,
    command: input.command,
    interpreter: shell.application,
    cwd,
    pty,
    timeoutSeconds: input.timeout ?? 0,
    createdAt: Date.now(),
    ...(input.ready !== undefined ? { ready: input.ready } : {}),
  };
  return { scope, client, intent, size, waitMs };
}
