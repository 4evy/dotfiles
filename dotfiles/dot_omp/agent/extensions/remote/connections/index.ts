import { posix } from "node:path";
import {
  ensureConnection,
  ensureHostInfo,
  getControlDir,
} from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { helperStatus } from "../helper/helper";
import { probeConnection } from "./probe";
import { configuredHosts, fileRoot, identifier, resolveTarget } from "./target";
import type { ConnectInput, Connection } from "./types";

export async function connect(
  input: ConnectInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<Connection> {
  signal?.throwIfAborted();
  identifier(input.target, "SSH target");
  const { hosts } = await configuredHosts(cwd);
  signal?.throwIfAborted();
  const { target, digest, id, configured } = resolveTarget(input, cwd, hosts);
  // Native setup has fixed per-call budgets and cannot observe caller aborts
  // Checking between calls does not turn this into one overall deadline
  signal?.throwIfAborted();
  await ensureConnection(target);
  signal?.throwIfAborted();
  const info = await ensureHostInfo(target);
  signal?.throwIfAborted();
  const controlPath = posix.join(getControlDir(), `r-${digest.slice(0, 32)}.sock`);
  if (info.os === "windows" || !info.transferShell) {
    throw new Error(
      "Remote connections require a verified POSIX transfer shell on a non-Windows host",
    );
  }
  const facts = await probeConnection(
    target,
    info,
    input.cwd,
    cwd,
    controlPath,
    signal,
  );
  const connection: Connection = {
    id,
    target,
    info,
    ...facts,
    controlPath,
    fileRoot: fileRoot(target, configured, hosts),
  };
  try {
    connection.helper = await helperStatus(connection, signal);
  } catch (error) {
    signal?.throwIfAborted();
    connection.helper = {
      installed: false,
      jobsReady: false,
      reason: `Helper status unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return connection;
}
