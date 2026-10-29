import { basename, dirname, join, resolve } from "node:path";
import { DotfilesError } from "@dotfiles/core/errors";
import { Effect, FileSystem } from "effect";
import {
  isDirectory,
  isRegular,
  isWithin,
  marshalPrettyJSON,
  parseJSONObject,
  pathExists,
  readUTF8,
  validate,
  writePrivate,
} from "./files.ts";
import { checkMaterialized } from "./source.ts";
import {
  type CollectionSet,
  collectionNames,
  decodeRecord,
  equalCollections,
  formatVersion,
  type RecordItem,
  recordCount,
  type Vault,
  validateCollections,
} from "./vault.ts";

export function unpackWorkspace(v: Vault, destination: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root, created } = yield* prepareDestination(v, destination);
    const value = yield* v.decryptCollections();
    const plan = yield* validate(() => planWorkspace(root, value));
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (created) yield* fs.makeDirectory(root, { mode: 0o700 });
        yield* restore(
          Effect.gen(function* () {
            yield* writeWorkspacePlan(plan);
            yield* v.stdout(`unpacked ${recordCount(value)} records into ${root}\n`);
          }),
        ).pipe(
          Effect.onError(() =>
            (created
              ? fs.remove(root, { recursive: true, force: true })
              : Effect.gen(function* () {
                  if (!(yield* directoryEmpty(root)))
                    yield* v.stderr(
                      `records: protected workspace retained at ${root}\n`,
                    );
                })
            ).pipe(Effect.ignore),
          ),
        );
      }),
    );
  });
}

export function packWorkspace(v: Vault, source: string) {
  return Effect.gen(function* () {
    const root = yield* existingWorkspace(v, source);
    const value = yield* readWorkspace(root);
    const current = yield* v.decryptCollections();
    if (equalCollections(value, current)) {
      yield* v.stdout("records unchanged\n");
      return;
    }
    yield* v.packCollections(value);
  });
}

export function check(v: Vault, source = "") {
  return Effect.gen(function* () {
    const value =
      source === ""
        ? yield* v.decryptCollections()
        : yield* readWorkspace(yield* existingWorkspace(v, source));
    if (source === "" && (yield* pathExists(v.marker)))
      yield* checkMaterialized(v, value);
    yield* v.stdout(`validated ${recordCount(value)} records\n`);
  });
}

export function prepareDestination(v: Vault, destination: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = resolve(destination);
    if (yield* pathExists(path)) {
      if (
        !(yield* isDirectory(path)) ||
        !(yield* directoryEmpty(path).pipe(Effect.orElseSucceed(() => false)))
      )
        return yield* Effect.fail(
          new DotfilesError(`workspace must be an empty directory: ${path}`),
        );
      return { root: yield* existingWorkspace(v, path), created: false };
    }
    if (!(yield* isDirectory(dirname(path))))
      return yield* Effect.fail(
        new DotfilesError(`workspace parent does not exist: ${dirname(path)}`),
      );
    const parent = yield* fs.realPath(dirname(path));
    const root = join(parent, basename(path));
    if (isWithin(v.repository, root))
      return yield* Effect.fail(
        new DotfilesError("plaintext workspaces must be outside the repository"),
      );
    return { root, created: true };
  });
}

export function existingWorkspace(v: Vault, source: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let path = resolve(source);
    const info = yield* fs
      .lstat(path)
      .pipe(
        Effect.mapError(
          () => new DotfilesError(`workspace is not a directory: ${path}`),
        ),
      );
    if (info.type === "SymbolicLink")
      return yield* Effect.fail(
        new DotfilesError(`workspace must not be a symlink: ${path}`),
      );
    if (info.type !== "Directory")
      return yield* Effect.fail(
        new DotfilesError(`workspace is not a directory: ${path}`),
      );
    path = yield* fs.realPath(path);
    if (isWithin(v.repository, path))
      return yield* Effect.fail(
        new DotfilesError("plaintext workspaces must be outside the repository"),
      );
    const resolvedInfo = yield* fs.lstat(path);
    if ((resolvedInfo.mode & 0o077) !== 0)
      return yield* Effect.fail(
        new DotfilesError("workspace permissions must not grant group or other access"),
      );
    return path;
  });
}

type WorkspaceEntry = { path: string; body?: string };

function planWorkspace(root: string, value: CollectionSet): WorkspaceEntry[] {
  validateCollections(value);
  const plan: WorkspaceEntry[] = [
    {
      path: join(root, "format.json"),
      body: `${marshalPrettyJSON({ collections: collectionNames, version: formatVersion })}\n`,
    },
  ];
  for (const collection of collectionNames) {
    const collectionRoot = join(root, collection);
    plan.push({ path: collectionRoot });
    const items = value[collection];
    if (!items) throw new DotfilesError(`missing collection: ${collection}`);
    for (const [index, item] of items.entries()) {
      const recordRoot = join(collectionRoot, indexName(index));
      const metadata = {
        executable: item.executable,
        paths: item.paths,
        private: item.private,
        render: item.render,
        systems: item.systems,
        ...(item.variants?.length ? { variants: item.variants } : {}),
      };
      plan.push(
        { path: recordRoot },
        {
          path: join(recordRoot, "metadata.json"),
          body: `${marshalPrettyJSON(metadata)}\n`,
        },
        { path: join(recordRoot, "body"), body: item.body },
      );
    }
  }
  return plan;
}

function writeWorkspacePlan(plan: WorkspaceEntry[]) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const entry of plan) {
      if (entry.body === undefined)
        yield* fs.makeDirectory(entry.path, { mode: 0o700 });
      else yield* writePrivate(entry.path, entry.body);
    }
  });
}

export function writeWorkspace(root: string, value: CollectionSet) {
  return validate(() => planWorkspace(root, value)).pipe(
    Effect.flatMap(writeWorkspacePlan),
  );
}

export function readWorkspace(root: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* assertEntries(root, ["format.json", ...collectionNames]);
    const formatPath = join(root, "format.json");
    if (!(yield* isRegular(formatPath)))
      return yield* Effect.fail(new DotfilesError("missing workspace format"));
    const format = yield* parseJSONObject(formatPath, "workspace format");
    if (Object.keys(format).some((key) => key !== "collections" && key !== "version"))
      return yield* Effect.fail(
        new DotfilesError("workspace format is not valid JSON (unknown field)"),
      );
    if (
      format.version !== formatVersion ||
      !Array.isArray(format.collections) ||
      format.collections.some((name: unknown) => typeof name !== "string") ||
      !equalNames(format.collections as string[], collectionNames)
    )
      return yield* Effect.fail(new DotfilesError("unsupported workspace format"));
    const result: CollectionSet = {};
    for (const collection of collectionNames) {
      const collectionRoot = join(root, collection);
      if (!(yield* isDirectory(collectionRoot)))
        return yield* Effect.fail(
          new DotfilesError(`missing collection directory: ${collection}`),
        );
      const entries = (yield* fs.readDirectory(collectionRoot)).sort();
      const items: RecordItem[] = [];
      for (const [index, name] of entries.entries()) {
        const recordRoot = join(collectionRoot, name);
        if (name !== indexName(index) || !(yield* isDirectory(recordRoot)))
          return yield* Effect.fail(
            new DotfilesError(
              `${collection} record directories must be contiguous and zero-padded`,
            ),
          );
        items.push(yield* readWorkspaceRecord(recordRoot, collection, index));
      }
      result[collection] = items;
    }
    yield* validate(() => validateCollections(result));
    return result;
  });
}

function readWorkspaceRecord(root: string, collection: string, index: number) {
  return Effect.gen(function* () {
    yield* assertEntries(root, ["body", "metadata.json"]);
    const label = `${collection} record ${indexName(index)}`;
    const metadata = yield* parseJSONObject(
      join(root, "metadata.json"),
      `${label} metadata`,
    );
    const bodyPath = join(root, "body");
    if (!(yield* isRegular(bodyPath)))
      return yield* Effect.fail(
        new DotfilesError(`${label} body must be a regular file`),
      );
    metadata.body = yield* readUTF8(bodyPath, `${label} body`);
    return yield* validate(() => decodeRecord(metadata, collection, index));
  });
}

function assertEntries(directory: string, expected: readonly string[]) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!equalNames(yield* fs.readDirectory(directory), expected))
      return yield* Effect.fail(
        new DotfilesError(`unexpected files in protected workspace: ${directory}`),
      );
  });
}

function equalNames(actual: readonly string[], expected: readonly string[]): boolean {
  const names = new Set(actual);
  return names.size === expected.length && expected.every((name) => names.has(name));
}

export function directoryEmpty(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.readDirectory(path)).length === 0;
  });
}

export function validateEditTarget(collection: string, index: string): void {
  if (index !== "" && collection === "")
    throw new DotfilesError("an index requires a collection");
  if (collection !== "" && !collectionNames.some((name) => name === collection))
    throw new DotfilesError(`unknown collection: ${collection}`);
  if (index === "") return;
  if (
    !/^[+-]?\d+$/.test(index) ||
    BigInt(index) < 0n ||
    BigInt(index) > 9223372036854775807n
  )
    throw new DotfilesError("record index must be a non-negative integer");
}

function indexName(index: number): string {
  return String(index).padStart(3, "0");
}
