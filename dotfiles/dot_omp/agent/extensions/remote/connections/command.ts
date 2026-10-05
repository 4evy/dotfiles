import {
  buildRemoteCommand,
  ensureConnection,
  type SSHConnectionTarget,
  type SSHHostInfo,
} from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { wrapInPosixShell } from "@oh-my-pi/pi-coding-agent/ssh/utils";
import type { Connection } from "./types";

export async function argv(
  target: SSHConnectionTarget,
  info: SSHHostInfo,
  script: string,
  pty: boolean,
  controlPath: string,
): Promise<string[]> {
  if (info.os === "windows" || !info.transferShell) {
    throw new Error(
      "Remote connections require a verified POSIX transfer shell on a non-Windows host",
    );
  }
  const native = await buildRemoteCommand(
    target,
    wrapInPosixShell(info.transferShell, script),
    { allowStdin: true },
  );
  // Native %C excludes IdentityFile, so distinct keys need isolated control paths
  return [
    pty ? "-tt" : "-T",
    "-o",
    `ControlPath=${controlPath}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    ...native,
  ];
}

export async function remoteArgv(
  connection: Connection,
  script: string,
  pty: boolean,
): Promise<string[]> {
  await ensureConnection(connection.target);
  return argv(connection.target, connection.info, script, pty, connection.controlPath);
}
