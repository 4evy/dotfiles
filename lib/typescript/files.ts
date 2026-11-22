import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import { basename, dirname, join, normalize } from "node:path";
import { Effect, FileSystem } from "effect";
import { DotfilesError } from "./errors.ts";

const DEFAULT_FILE_MODE = 0o644;
// Include setuid, setgid, and sticky bits when validating and preserving modes
const PERMISSION_BITS = 0o7777;

// Write JSON atomically and report whether content or permissions changed
export function writeJson(
  path: string,
  value: unknown,
  mode: number | string = DEFAULT_FILE_MODE,
) {
  return writeIfChanged(path, `${JSON.stringify(value, null, 2)}\n`, mode);
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
  if (!Number.isInteger(mode) || mode < 0 || mode > PERMISSION_BITS)
    throw new DotfilesError(`Mode must be a permission mode: ${value}`);
  return mode;
}

export function isExecutable(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // The platform service has no executable-access check
    yield* Effect.tryPromise(() => access(path, constants.X_OK));
    return (yield* fs.stat(path)).type === "File";
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

export function ensureDirectory(path: string, mode?: number | string) {
  return Effect.gen(function* () {
    const directory = yield* Effect.try(() => safePath(path));
    const permission =
      mode === undefined ? undefined : yield* Effect.try(() => octalMode(mode));
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(directory, { recursive: true });
    if (permission !== undefined) yield* fs.chmod(directory, permission);
    return directory;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DotfilesError(`Could not create ${path}: ${cause.message}`, {
          cause,
        }),
    ),
  );
}

// Set the mode on the exclusive descriptor, independent of umask
export function writeExclusiveFile(
  path: string,
  content: string | Uint8Array,
  mode: number,
  durable = false,
) {
  return Effect.tryPromise(async () => {
    await using file = await open(path, "wx", mode);
    await file.chmod(mode);
    await file.writeFile(content);
    if (durable) await file.sync();
  }).pipe(Effect.uninterruptible);
}

// Publish a fully written file without mutating the previous inode
export function writeAtomicFile(
  path: string,
  content: string | Uint8Array,
  mode: number,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: dirname(path),
        prefix: ".dotfiles-write-",
      });
      const temporary = join(staging, "file");
      yield* writeExclusiveFile(temporary, content, mode, true);
      yield* fs.rename(temporary, path);
    }),
  );
}

export function writeIfChanged(
  path: string,
  content: string | Uint8Array,
  mode: number | string = DEFAULT_FILE_MODE,
) {
  return Effect.gen(function* () {
    const destination = yield* Effect.try(() => safePath(path));
    const permission = yield* Effect.try(() => octalMode(mode));
    const data = typeof content === "string" ? Buffer.from(content) : content;
    const fs = yield* FileSystem.FileSystem;
    const status = yield* fs.stat(destination).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
      ),
    );
    if (
      status?.type === "File" &&
      Buffer.compare(yield* fs.readFile(destination), data) === 0
    ) {
      if ((status.mode & PERMISSION_BITS) === permission) return false;
      yield* fs.chmod(destination, permission);
      return true;
    }
    yield* ensureDirectory(dirname(destination));
    yield* writeAtomicFile(destination, data, permission);
    return true;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DotfilesError(`Could not write ${path}: ${cause.message}`, {
          cause,
        }),
    ),
  );
}
