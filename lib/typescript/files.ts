import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, normalize } from "node:path";
import { DotfilesError } from "./errors.ts";

export async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function safePath(path: string): string {
  const normalized = normalize(path);
  if (
    !path ||
    ["/", ".", ".."].includes(normalized) ||
    [".", ".."].includes(basename(path))
  )
    throw new DotfilesError(`Refusing unsafe path: ${path}`);
  return normalized;
}

function octalMode(value: number | string): number {
  if (typeof value === "string" && !/^[0-7]+$/.test(value))
    throw new DotfilesError(`Mode must be octal: ${value}`);
  const mode = typeof value === "number" ? value : Number.parseInt(value, 8);
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)
    throw new DotfilesError(`Mode must be a permission mode: ${value}`);
  return mode;
}

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function ensureDirectory(path: string, mode?: number | string): string {
  const directory = safePath(path);
  mkdirSync(directory, { recursive: true });
  if (mode !== undefined) chmodSync(directory, octalMode(mode));
  return directory;
}

export function writeIfChanged(
  path: string,
  content: string | Uint8Array,
  mode: number | string = 0o644,
): boolean {
  const destination = safePath(path);
  const data = Buffer.from(content);
  const permission = octalMode(mode);
  if (
    existsSync(destination) &&
    statSync(destination).isFile() &&
    readFileSync(destination).equals(data)
  ) {
    if ((statSync(destination).mode & 0o7777) === permission) return false;
    chmodSync(destination, permission);
    return true;
  }
  ensureDirectory(dirname(destination));
  const temporary = `${destination}.${randomUUID()}`;
  const descriptor = openSync(temporary, "wx", permission);
  try {
    try {
      fchmodSync(descriptor, permission);
      writeFileSync(descriptor, data);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}
