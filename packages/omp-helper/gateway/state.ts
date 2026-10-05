import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { z } from "zod";

export const PROTOCOL_MAJOR = 1;
export const VERSION = "1.0.0";
export {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES as MAX_DESKTOP_RESPONSE_BYTES,
} from "../../../dotfiles/dot_omp/agent/lib/desktop/protocol";

function directory(variable: string, fallback: string): string {
  const value = process.env[variable] || fallback;
  if (!isAbsolute(value) || value.includes("\0") || value.includes("\n")) {
    throw new Error(`${variable} must be an absolute directory path`);
  }
  return value;
}

export function paths() {
  const home = homedir();
  return {
    state: join(directory("XDG_STATE_HOME", join(home, ".local/state")), "omp-helper"),
    data: join(directory("XDG_DATA_HOME", join(home, ".local/share")), "omp-helper"),
    config: directory("XDG_CONFIG_HOME", join(home, ".config")),
    runtime: join(
      directory(
        "XDG_RUNTIME_DIR",
        process.platform === "darwin"
          ? join(
              directory("XDG_STATE_HOME", join(home, ".local/state")),
              "omp-helper/runtime",
            )
          : `/run/user/${process.getuid?.()}`,
      ),
      "omp-helper",
    ),
  };
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(
      `Private directory has unsafe ownership, type or permissions: ${path}`,
    );
  }
}

export async function privateRead(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    const link = await lstat(path);
    if (
      !info.isFile() ||
      link.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error(
        `Private file has unsafe ownership, type or permissions: ${path}`,
      );
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

export async function atomicWrite(
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temporary = join(dirname(path), `.omp-helper-${randomUUID()}`);
  const file = await open(temporary, "wx", mode);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

const identitySchema = z.strictObject({ installationId: z.uuid() });
export async function loadIdentity(): Promise<z.infer<typeof identitySchema>> {
  const state = paths().state;
  await privateDirectory(state);
  const path = join(state, "installation.json");
  try {
    return identitySchema.parse(JSON.parse(await privateRead(path)));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  const identity = { installationId: randomUUID() };
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(identity)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!isEexist(error)) throw error;
    return identitySchema.parse(JSON.parse(await privateRead(path)));
  }
  return identity;
}

export async function withMaintenanceLock<T>(work: () => Promise<T>): Promise<T> {
  const state = paths().state;
  await privateDirectory(state);
  const lock = join(state, "maintenance.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (isEexist(error)) {
      throw new Error(
        "Helper is busy with a launch or installation operation; no operation was replayed",
      );
    }
    throw error;
  }
  try {
    await atomicWrite(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    return await work();
  } finally {
    await rm(lock, { recursive: true });
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}
