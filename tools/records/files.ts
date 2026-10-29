import { chmodSync } from "node:fs";
import { open, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DotfilesError } from "@dotfiles/core/errors";
import { Effect, FileSystem, Stdio, Stream } from "effect";
import { visit } from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";

export function validate<A>(calculation: () => A) {
  return Effect.try({
    try: calculation,
    catch: (cause) =>
      cause instanceof DotfilesError
        ? cause
        : new DotfilesError("invalid records data"),
  });
}

export function pathInfo(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.lstat(path).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
      ),
    );
  });
}

export function isRegular(path: string) {
  return pathInfo(path).pipe(Effect.map((info) => info?.type === "File"));
}

export function isDirectory(path: string) {
  return pathInfo(path).pipe(Effect.map((info) => info?.type === "Directory"));
}

export function isExecutable(path: string) {
  return pathInfo(path).pipe(
    Effect.map((info) => info?.type === "File" && (info.mode & 0o111) !== 0),
  );
}

export function pathExists(path: string) {
  return pathInfo(path).pipe(Effect.map((info) => info !== undefined));
}

export function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function writePrivate(path: string, content: string | Uint8Array) {
  return Effect.scoped(
    Effect.gen(function* () {
      // FileSystem.File has no descriptor chmod, which must not follow symlinks
      const file = yield* Effect.acquireRelease(
        Effect.tryPromise(() => open(path, "wx", 0o600)),
        (descriptor) => Effect.promise(() => descriptor.close()),
      );
      yield* Effect.tryPromise(() => file.chmod(0o600));
      yield* Effect.tryPromise(() => file.writeFile(content));
    }),
  ).pipe(
    Effect.mapError(() => new DotfilesError(`could not write private file: ${path}`)),
  );
}

export function replaceTextFile(
  path: string,
  content: string | Uint8Array,
  mode: number,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: dirname(path),
        prefix: ".records-write-",
      });
      yield* fs.chmod(directory, 0o700);
      const replacement = join(directory, "replacement");
      const permission = mode & 0o777;
      // Stage privately so the atomic-write library cannot follow a symlink
      // Let the library settle before scope cleanup, even on interruption
      yield* Effect.tryPromise(() =>
        writeFileAtomic(
          replacement,
          typeof content === "string" ? content : Buffer.from(content),
          {
            mode: permission,
            tmpfileCreated: (temporary) => chmodSync(temporary, permission),
          },
        ),
      ).pipe(Effect.uninterruptible);
      // The library skips its final chmod when the requested mode is zero
      yield* fs.chmod(replacement, permission);
      yield* fs.rename(replacement, path);
    }),
  ).pipe(Effect.mapError(() => new DotfilesError(`could not replace file: ${path}`)));
}

export function removeEmptyDirectory(path: string) {
  // FileSystem.remove uses rm, which cannot remove only an empty directory
  return Effect.tryPromise({
    try: () => rmdir(path),
    catch: () => new DotfilesError(`could not remove empty directory: ${path}`),
  });
}

export function readUTF8(path: string, label: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* isRegular(path)))
      return yield* Effect.fail(new DotfilesError(`missing ${label}`));
    const content = yield* fs.readFile(path);
    return yield* Effect.try({
      try: () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content),
      catch: () => new DotfilesError(`${label} is not valid UTF-8`),
    });
  });
}

export function parseJSON(content: string, label: string): unknown {
  const objects: Set<string>[] = [];
  let invalid = !content.isWellFormed();
  visit(
    content,
    {
      onObjectBegin: () => {
        objects.push(new Set());
      },
      onObjectProperty: (property) => {
        const keys = objects.at(-1);
        if (!property.isWellFormed() || keys?.has(property)) invalid = true;
        keys?.add(property);
      },
      onObjectEnd: () => {
        objects.pop();
      },
      onLiteralValue: (value: unknown) => {
        if (typeof value === "string" && !value.isWellFormed()) invalid = true;
      },
      onError: () => {
        invalid = true;
      },
    },
    { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
  );
  if (!invalid) {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      // Native parse diagnostics can include private values
    }
  }
  throw new DotfilesError(`${label} is not valid UTF-8 JSON`);
}

export function parseJSONObject(path: string, label: string) {
  return Effect.gen(function* () {
    const content = yield* readUTF8(path, label);
    return yield* validate(() => {
      const value = parseJSON(content, label);
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new DotfilesError(`${label} must be an object`);
      return value as Record<string, unknown>;
    });
  });
}

function deterministic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deterministic);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, deterministic((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function marshalJSON(value: unknown): string {
  const encoded = JSON.stringify(deterministic(value));
  if (encoded === undefined) throw new DotfilesError("value cannot be encoded as JSON");
  return encoded;
}

export function marshalPrettyJSON(value: unknown): string {
  const encoded = JSON.stringify(deterministic(value), null, 2);
  if (encoded === undefined) throw new DotfilesError("value cannot be encoded as JSON");
  return encoded;
}

export function writeOutput(channel: "stdout" | "stderr", value: string) {
  return Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.run(Stream.make(value), stdio[channel]());
  });
}
