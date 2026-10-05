import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { readRemoteFile } from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { Connection } from "../../connections/types";
import { MAX_FILE_BYTES } from "../schemas/files";

export const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export async function readComplete(
  connection: Connection,
  path: string,
  signal?: AbortSignal,
) {
  const read = await readRemoteFile(connection.target, path, {
    maxBytes: MAX_FILE_BYTES,
    ...(signal ? { signal } : {}),
  });
  if (read.truncated)
    throw new Error(
      `Remote file exceeds ${MAX_FILE_BYTES} bytes; use remote_run for larger files`,
    );
  return read.bytes;
}

export function checkHash(bytes: Uint8Array, expected?: string) {
  if (expected !== undefined && hash(bytes) !== expected)
    throw new Error(
      "Remote file changed since the expected read; read it again before editing",
    );
}

export async function staging<T>(
  path: string,
  operation: (file: string, session: ToolSession) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "omp-remote-file-"));
  // Keep the format extension while avoiding native selector syntax in filenames
  const extension = posix.extname(path);
  const file = join(
    directory,
    `file${/^\.[A-Za-z0-9]+$/u.test(extension) ? extension : ""}`,
  );
  const session: ToolSession = {
    cwd: directory,
    hasUI: false,
    enableLsp: false,
    hasEditTool: true,
    settings: Settings.isolated({
      "edit.mode": "replace",
      "read.summarize.enabled": false,
    }),
    getSessionFile: () => null,
    getSessionSpawns: () => "",
  };
  try {
    return await operation(file, session);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
