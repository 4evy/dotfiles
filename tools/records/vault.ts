import { basename, dirname, join, resolve } from "node:path";
import { DotfilesError } from "@dotfiles/core/errors";
import { exitCode } from "@dotfiles/runtime/process";
import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess } from "effect/process";
import * as v from "valibot";
import {
  isExecutable,
  isRegular,
  marshalJSON,
  parseJSON,
  replaceTextFile,
  validate,
  writeOutput,
  writePrivate,
} from "./files.ts";

export const formatVersion = 1;
export const layoutVersion = 2;
export const collectionNames: readonly string[] = ["t0"];
const collectionNameSet = new Set(collectionNames);

export interface RecordVariant {
  system: string;
  hostname?: string;
  body: string;
}

export interface RecordItem {
  body: string;
  executable: boolean;
  paths: string[];
  private: boolean;
  render: boolean;
  systems: string[];
  variants?: RecordVariant[];
}

export type CollectionSet = Record<string, RecordItem[]>;

export interface RecordRef {
  collection: string;
  index: number;
  record: RecordItem;
}

export function* records(value: CollectionSet): Generator<RecordRef> {
  for (const collection of collectionNames) {
    for (const [index, record] of (value[collection] ?? []).entries()) {
      yield { collection, index, record };
    }
  }
}

export function validRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.isWellFormed() &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

const systemSchema = v.picklist(["darwin", "linux"]);
const bodySchema = v.pipe(
  v.string(),
  v.check((value) => value.isWellFormed()),
);
// Serialized records have no defaults and reject unknown fields at every level
const collectionSchemas: Record<string, v.GenericSchema<unknown, RecordItem>> = {
  t0: v.strictObject({
    body: bodySchema,
    executable: v.boolean(),
    paths: v.pipe(
      v.array(v.pipe(v.string(), v.check(validRelativePath))),
      v.minLength(1),
      v.check((paths) => new Set(paths).size === paths.length),
    ),
    private: v.boolean(),
    render: v.boolean(),
    systems: v.pipe(
      v.array(systemSchema),
      v.check((systems) => new Set(systems).size === systems.length),
    ),
    variants: v.exactOptional(
      v.array(
        v.strictObject({
          system: systemSchema,
          hostname: v.exactOptional(v.pipe(bodySchema, v.minLength(1))),
          body: bodySchema,
        }),
      ),
    ),
  }),
};

function recordLabel(collection: string, index: number): string {
  return `${collection} record ${String(index).padStart(3, "0")}`;
}

export function decodeRecord(
  value: unknown,
  collection: string,
  index: number,
): RecordItem {
  const label = recordLabel(collection, index);
  const schema = Object.hasOwn(collectionSchemas, collection)
    ? collectionSchemas[collection]
    : undefined;
  if (!schema) throw new DotfilesError(`unknown collection: ${collection}`);
  const result = v.safeParse(schema, value, { abortEarly: true });
  if (!result.success) {
    // Report schema paths and constraints, never private values or messages
    const failure = result.issues[0];
    const location =
      failure.type === "strict_object" ? failure.path?.slice(0, -1) : failure.path;
    const path = location?.map((item) => String(item.key)).join("/") ?? "";
    throw new DotfilesError(`${label} invalid field /${path} (${failure.type})`);
  }
  return result.output;
}

export function validateCollections(value: CollectionSet): void {
  const keys = Object.keys(value);
  if (
    keys.length !== collectionNameSet.size ||
    keys.some((key) => !collectionNameSet.has(key))
  ) {
    throw new DotfilesError(
      `manifest must contain exactly ${collectionNames.join(", ")}`,
    );
  }
  for (const collection of collectionNames) {
    const items = value[collection];
    if (!Array.isArray(items))
      throw new DotfilesError(`${collection} manifest must be an array`);
    const targets = new Set<string>();
    for (const [index, item] of items.entries()) {
      const record = decodeRecord(item, collection, index);
      const selectors = new Set<string>();
      for (const variant of record.variants ?? []) {
        const selector = `${variant.system}\0${variant.hostname ?? ""}`;
        if (selectors.has(selector)) {
          throw new DotfilesError(
            `${recordLabel(collection, index)} has duplicate platform variants`,
          );
        }
        selectors.add(selector);
      }
      for (const target of record.paths) {
        if (targets.has(target))
          throw new DotfilesError(`${collection} destinations must be unique`);
        targets.add(target);
      }
    }
  }
}

export function equalCollections(left: CollectionSet, right: CollectionSet): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((collection) => {
    const leftRecords = left[collection];
    const rightRecords = right[collection];
    return (
      leftRecords !== undefined &&
      rightRecords !== undefined &&
      leftRecords.length === rightRecords.length &&
      leftRecords.every((record, index) => {
        const other = rightRecords[index];
        if (!other) return false;
        const variants = record.variants ?? [];
        const otherVariants = other.variants ?? [];
        return (
          record.body === other.body &&
          record.executable === other.executable &&
          record.private === other.private &&
          record.render === other.render &&
          record.paths.length === other.paths.length &&
          record.paths.every((path, pathIndex) => path === other.paths[pathIndex]) &&
          record.systems.length === other.systems.length &&
          record.systems.every(
            (system, systemIndex) => system === other.systems[systemIndex],
          ) &&
          variants.length === otherVariants.length &&
          variants.every((variant, variantIndex) => {
            const otherVariant = otherVariants[variantIndex];
            return (
              otherVariant !== undefined &&
              variant.system === otherVariant.system &&
              (variant.hostname ?? "") === (otherVariant.hostname ?? "") &&
              variant.body === otherVariant.body
            );
          })
        );
      })
    );
  });
}

export function recordCount(value: CollectionSet): number {
  return Object.values(value).reduce((count, items) => count + items.length, 0);
}

interface VaultOptions {
  repository: string;
  file: string;
  marker: string;
  source: string;
  searchIgnore: string;
  sops: string;
}

export class Vault {
  readonly repository: string;
  readonly file: string;
  readonly marker: string;
  readonly source: string;
  readonly searchIgnore: string;
  readonly sops: string;

  constructor(options: VaultOptions) {
    this.repository = options.repository;
    this.file = options.file;
    this.marker = options.marker;
    this.source = options.source;
    this.searchIgnore = options.searchIgnore;
    this.sops = options.sops;
  }

  stdout(value: string) {
    return writeOutput("stdout", value);
  }

  stderr(value: string) {
    return writeOutput("stderr", value);
  }

  static create() {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configured = process.env.RECORDS_REPOSITORY;
      const repository = yield* fs
        .realPath(configured ?? (yield* defaultRepository()))
        .pipe(
          Effect.map(resolve),
          Effect.mapError(() => new DotfilesError("resolve records repository failed")),
        );
      return new Vault({
        repository,
        file: resolve(
          process.env.RECORDS_FILE ?? join(repository, "secrets", "records.yaml"),
        ),
        marker: resolve(
          process.env.RECORDS_MARKER ?? join(repository, ".records-unpacked"),
        ),
        source: resolve(
          process.env.RECORDS_SOURCE ?? join(repository, "home", "records"),
        ),
        searchIgnore: resolve(
          process.env.RECORDS_SEARCH_IGNORE ?? join(repository, ".ignore"),
        ),
        sops: process.env.RECORDS_SOPS ?? "sops",
      });
    });
  }

  decryptCollections(file: string = this.file) {
    return Effect.gen({ self: this }, function* () {
      const output = yield* this.runSOPS(
        undefined,
        "decrypt",
        "--input-type",
        "yaml",
        "--output-type",
        "json",
        "--extract",
        '["items"]',
        file,
      );
      return yield* validate(() => {
        const items = parseJSON(output, "encrypted manifest");
        if (items === null || typeof items !== "object" || Array.isArray(items))
          throw new DotfilesError("encrypted manifest must be an object");
        const result: CollectionSet = {};
        for (const collection of collectionNames) {
          if (!Object.hasOwn(items, collection))
            throw new DotfilesError(
              `encrypted manifest is missing a collection (${collection})`,
            );
          const manifest = (items as Record<string, unknown>)[collection];
          if (typeof manifest !== "string")
            throw new DotfilesError(
              `encrypted ${collection} manifest must be a string`,
            );
          const rawRecords = parseJSON(manifest, "encrypted manifest");
          if (!Array.isArray(rawRecords))
            throw new DotfilesError(`${collection} manifest must be an array`);
          result[collection] = rawRecords.map((record, index) =>
            decodeRecord(record, collection, index),
          );
        }
        validateCollections(result);
        return result;
      });
    });
  }

  packCollections(value: CollectionSet) {
    return Effect.gen({ self: this }, function* () {
      const encoded = yield* validate(() => {
        validateCollections(value);
        return marshalJSON(
          Object.fromEntries(
            collectionNames.map((collection) => [
              collection,
              marshalJSON(value[collection]),
            ]),
          ),
        );
      });
      yield* this.replaceVault(encoded, value);
      yield* this.stdout(
        `packed ${recordCount(value)} records into the encrypted vault\n`,
      );
    });
  }

  private replaceVault(encodedItems: string, expected: CollectionSet) {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const fs = yield* FileSystem.FileSystem;
        const info = yield* fs.stat(this.file);
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: dirname(this.file),
          prefix: `${basename(this.file)}.sops.`,
        });
        yield* fs.chmod(directory, 0o700);
        const scratch = join(directory, "vault.yaml");
        yield* writePrivate(scratch, yield* fs.readFile(this.file));
        yield* this.runSOPS(
          encodedItems,
          "--filename-override",
          this.file,
          "set",
          "--input-type",
          "yaml",
          "--output-type",
          "yaml",
          "--idempotent",
          "--value-stdin",
          scratch,
          '["items"]',
        );
        const roundTrip = yield* this.decryptCollections(scratch);
        if (!equalCollections(roundTrip, expected))
          return yield* Effect.fail(
            new DotfilesError("encrypted vault did not round-trip"),
          );
        yield* replaceTextFile(
          this.file,
          yield* fs.readFile(scratch),
          info.mode & 0o777,
        );
      }),
    );
  }

  runSOPS(input: string | undefined, ...arguments_: string[]) {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const env = { ...process.env };
        const config = join(this.repository, ".sops.yaml");
        if (
          !env.SOPS_CONFIG &&
          (yield* isRegular(config).pipe(Effect.orElseSucceed(() => false)))
        )
          env.SOPS_CONFIG = config;
        const helper = join(
          this.repository,
          "home",
          "files",
          ".local",
          "lib",
          "sops",
          "sops.sh",
        );
        if (
          !env.SOPS_AGE_KEY_CMD &&
          process.platform === "darwin" &&
          (yield* isExecutable(helper).pipe(Effect.orElseSucceed(() => false)))
        )
          env.SOPS_AGE_KEY_CMD = helper;
        const child = yield* ChildProcess.make(this.sops, arguments_, {
          env,
          extendEnv: true,
          // Key helpers may need the controlling terminal with piped stdio
          detached: false,
          stdin:
            input === undefined
              ? "ignore"
              : Stream.make(new TextEncoder().encode(input)),
          stdout: "pipe",
          // SOPS diagnostics can contain malformed decrypted values
          stderr: "ignore",
        }).pipe(
          Effect.catchDefect(() =>
            Effect.fail(new DotfilesError("sops command failed")),
          ),
        );
        const result = yield* Effect.all(
          { code: exitCode(child), chunks: Stream.runCollect(child.stdout) },
          { concurrency: "unbounded" },
        );
        if (result.code !== 0)
          return yield* Effect.fail(new DotfilesError("sops command failed"));
        return yield* Effect.try({
          try: () =>
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              Buffer.concat(result.chunks),
            ),
          catch: () => new DotfilesError("sops command failed"),
        });
      }),
    ).pipe(Effect.mapError(() => new DotfilesError("sops command failed")));
  }
}

function defaultRepository() {
  return Effect.gen(function* () {
    const candidates = [process.cwd(), dirname(process.execPath), import.meta.dir];
    for (const candidate of candidates) {
      let current = resolve(candidate);
      while (true) {
        if (
          (yield* isRegular(join(current, "secrets", "records.yaml")).pipe(
            Effect.orElseSucceed(() => false),
          )) &&
          (yield* isRegular(join(current, ".sops.yaml")).pipe(
            Effect.orElseSucceed(() => false),
          ))
        )
          return current;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    return candidates[0] ?? ".";
  });
}
