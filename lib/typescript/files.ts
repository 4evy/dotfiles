import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import { basename, dirname, normalize } from "node:path";
import { Crypto, Effect, FileSystem } from "effect";
import { DotfilesError } from "./errors.ts";

// Write JSON atomically and report whether content or permissions changed
export function writeJson(path: string, value: unknown, mode: number | string = 0o644) {
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
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)
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
        new DotfilesError(`Could not create ${path}: ${cause.message}`, { cause }),
    ),
  );
}

export function writeIfChanged(
  path: string,
  content: string | Uint8Array,
  mode: number | string = 0o644,
) {
  return Effect.scoped(
    Effect.gen(function* () {
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
        if ((status.mode & 0o7777) === permission) return false;
        yield* fs.chmod(destination, permission);
        return true;
      }
      yield* ensureDirectory(dirname(destination));
      const crypto = yield* Crypto.Crypto;
      const temporary = `${destination}.${yield* crypto.randomUUIDv4()}`;
      yield* Effect.addFinalizer(() =>
        fs.remove(temporary, { force: true }).pipe(Effect.orDie),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          // FileSystem.File lacks fchmod, which must target the open descriptor
          const descriptor = yield* Effect.acquireRelease(
            Effect.tryPromise(() => open(temporary, "wx", permission)),
            (file) => Effect.promise(() => file.close()),
          );
          yield* Effect.tryPromise(() => descriptor.chmod(permission));
          yield* Effect.tryPromise(() => descriptor.writeFile(data));
          yield* Effect.tryPromise(() => descriptor.sync());
        }),
      );
      yield* fs.rename(temporary, destination);
      return true;
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new DotfilesError(`Could not write ${path}: ${cause.message}`, { cause }),
    ),
  );
}
