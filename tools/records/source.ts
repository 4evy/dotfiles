import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { Effect, Exit, FileSystem } from "effect";
import { split } from "shellwords-ts";
import {
  isDirectory,
  isRegular,
  isWithin,
  marshalJSON,
  parseJSON,
  pathExists,
  pathInfo,
  readUTF8,
  removeEmptyDirectory,
  replaceTextFile,
  validate,
  writePrivate,
} from "./files.ts";
import {
  type CollectionSet,
  equalCollections,
  layoutVersion,
  type RecordRef,
  records,
  type Vault,
  validateCollections,
  validRelativePath,
} from "./vault.ts";
import {
  directoryEmpty,
  packWorkspace,
  validateEditTarget,
  writeWorkspace,
} from "./workspace.ts";

type SourceFile = { path: string; body: string; mode: number };
const pad = (value: number) => String(value).padStart(3, "0");

function delimitedBlock(begin: string, end: string) {
  const pattern = new RegExp(`^${begin}\\n.*?^${end}\\n?`, "ms");
  const remove = (content: string) => content.replace(pattern, "");
  return {
    remove,
    replace: (content: string, entries: string[]) =>
      [remove(content).trimEnd(), begin, ...entries, end].filter(Boolean).join("\n"),
  };
}
const localExcludeBlock = delimitedBlock(
  "# BEGIN dotfiles encrypted records",
  "# END dotfiles encrypted records",
);
const searchIgnoreBlock = delimitedBlock(
  "# BEGIN dotfiles decrypted records",
  "# END dotfiles decrypted records",
);

function sourcePathFor(v: Vault, target: string): string {
  if (!validRelativePath(target))
    throw new DotfilesError("record target must be a safe relative path");
  return join(v.source, target);
}

function variantSourcePath(
  v: Vault,
  current: RecordRef,
  target: string,
  variant: number,
): string {
  const path = sourcePathFor(v, target);
  return variant < 0
    ? path
    : join(
        v.source,
        ".variants",
        current.collection,
        pad(current.index),
        pad(variant),
        target,
      );
}

export function sourceFiles(v: Vault, value: CollectionSet): SourceFile[] {
  const seen = new Set<string>();
  const result: SourceFile[] = [];
  for (const current of records(value)) {
    const item = current.record;
    for (let variant = -1; variant < (item.variants?.length ?? 0); variant++) {
      const body = variant < 0 ? item.body : item.variants?.[variant]?.body;
      if (body === undefined) throw new DotfilesError("missing record variant");
      for (const target of item.paths) {
        const path = variantSourcePath(v, current, target, variant);
        if (seen.has(path))
          throw new DotfilesError(
            `${current.collection} record ${pad(current.index)} has a duplicate source path`,
          );
        if (path === v.marker || path === v.searchIgnore)
          throw new DotfilesError(
            "plaintext records must not overlap records metadata",
          );
        seen.add(path);
        result.push({ path, body, mode: item.executable ? 0o700 : 0o600 });
      }
    }
  }
  for (const path of seen) {
    for (let parent = dirname(path); parent !== v.source; parent = dirname(parent)) {
      if (seen.has(parent))
        throw new DotfilesError("plaintext record destinations must not overlap");
    }
  }
  return result;
}

function validateSourceParents(path: string) {
  return Effect.gen(function* () {
    const parents: string[] = [];
    for (let current = dirname(path); ; current = dirname(current)) {
      parents.push(current);
      if (dirname(current) === current) break;
    }
    for (const parent of parents.reverse()) {
      const info = yield* pathInfo(parent);
      if (info !== undefined && info.type !== "Directory")
        return yield* Effect.fail(
          new DotfilesError(
            "plaintext record directories must not contain symlinks or non-directories",
          ),
        );
    }
  });
}

export function unpackSource(v: Vault) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const value = yield* v.decryptCollections();
    const sources = yield* validate(() => sourceFiles(v, value));
    const conflicts: string[] = [];
    for (const source of sources) {
      yield* validateSourceParents(source.path);
      if (!(yield* pathExists(source.path))) continue;
      if (yield* isRegular(source.path)) {
        if (
          Buffer.compare(yield* fs.readFile(source.path), Buffer.from(source.body)) ===
          0
        )
          continue;
      }
      conflicts.push(relative(v.repository, source.path));
    }
    if (conflicts.length)
      return yield* Effect.fail(
        new DotfilesError(
          `refusing to overwrite changed plaintext records: ${conflicts.join(", ")}`,
        ),
      );
    yield* validateSourceParents(v.marker);
    if ((yield* pathExists(v.marker)) && !(yield* isRegular(v.marker)))
      return yield* Effect.fail(
        new DotfilesError(`records marker must be a regular file: ${v.marker}`),
      );
    // Resolve every conflict and calculate all metadata before changing Git excludes
    const overlay = yield* planSearchIgnore(v, sources);
    const paths = [...sources.map((source) => source.path), v.searchIgnore];
    const exclude = yield* planLocalExcludes(v, paths);
    yield* replaceTextFile(exclude.path, exclude.body, exclude.mode);
    yield* verifyGitExcludes(v, paths);
    const created: string[] = [];
    yield* Effect.gen(function* () {
      for (const source of sources) {
        if (!(yield* pathExists(source.path))) {
          yield* fs.makeDirectory(dirname(source.path), {
            recursive: true,
            mode: 0o700,
          });
          yield* writePrivate(source.path, source.body).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                created.push(source.path);
              }),
            ),
            Effect.uninterruptible,
          );
        }
        yield* fs.chmod(source.path, source.mode);
      }
      yield* replaceTextFile(v.searchIgnore, overlay.body, overlay.mode);
      yield* fs.chmod(v.searchIgnore, 0o600);
      yield* writeMarker(v);
    }).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          for (const path of created.reverse())
            if (yield* isRegular(path)) yield* fs.remove(path);
        }).pipe(Effect.orDie),
      ),
    );
    yield* v.stdout(`unpacked ${sources.length} plaintext files into ${v.source}\n`);
  });
}

export function packSource(v: Vault) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* requireUnpackedMarker(v);
    const current = yield* v.decryptCollections();
    yield* validateSearchIgnore(v, yield* validate(() => sourceFiles(v, current)));
    const updated = yield* collectionsWithSourceBodies(v, current);
    const sources = yield* validate(() => sourceFiles(v, updated));
    if (equalCollections(updated, current)) yield* v.stdout("records unchanged\n");
    else yield* v.packCollections(updated);
    for (const source of sources) {
      if (
        Buffer.compare(yield* fs.readFile(source.path), Buffer.from(source.body)) !== 0
      )
        yield* replaceTextFile(source.path, source.body, source.mode);
      yield* fs.chmod(source.path, source.mode);
    }
    yield* concealSourceFiles(v, sources);
  });
}

export function layout(v: Vault) {
  return Effect.gen(function* () {
    const value = yield* v.decryptCollections();
    const output = yield* validate(() => {
      const rows: string[][] = [];
      for (const current of records(value)) {
        const item = current.record;
        const flags =
          [
            item.private && "private",
            item.executable && "executable",
            item.render && "render",
          ]
            .filter(Boolean)
            .join(",") || "-";
        for (const target of item.paths)
          rows.push([
            `${current.collection}/${pad(current.index)}`,
            item.systems.join(",") || "all",
            flags,
            target,
            relative(v.repository, sourcePathFor(v, target)),
          ]);
        for (const [index, variant] of (item.variants ?? []).entries())
          for (const target of item.paths)
            rows.push([
              `${current.collection}/${pad(current.index)}.${pad(index)}`,
              variant.system,
              `variant${variant.hostname ? ",host-specific" : ""}`,
              target,
              relative(v.repository, variantSourcePath(v, current, target, index)),
            ]);
      }
      const widths = Array.from({ length: 4 }, (_, column) =>
        Math.max(0, ...rows.map((row) => row[column]?.length ?? 0)),
      );
      return rows
        .map(
          (row) =>
            `${row.map((cell, column) => (column < 4 ? cell.padEnd((widths[column] ?? 0) + 2) : cell)).join("")}\n`,
        )
        .join("");
    });
    yield* v.stdout(output);
  });
}

export function editSource(v: Vault, target = "") {
  return Effect.gen(function* () {
    yield* unpackSource(v);
    const editor = yield* validate(() =>
      editorCommand(process.env.VISUAL ?? process.env.EDITOR ?? ""),
    );
    const value = target ? yield* v.decryptCollections() : undefined;
    const home = process.env.HOME || homedir();
    const path = value
      ? yield* validate(() => resolveEditorTarget(v, target, value, home))
      : v.source;
    yield* run([...editor, path], {
      stdin: "inherit",
      outputMode: "inherit",
      stderr: "inherit",
    });
    yield* packSource(v);
  });
}

export function editWorkspace(v: Vault, collection = "", index = "") {
  return Effect.gen(function* () {
    yield* validate(() => validateEditTarget(collection, index));
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ prefix: "dotfiles-records-" }),
      (root) =>
        Effect.gen(function* () {
          yield* fs.chmod(root, 0o700);
          yield* writeWorkspace(root, yield* v.decryptCollections());
          const target = collection
            ? join(root, collection, ...(index ? [pad(Number(index))] : []))
            : root;
          if (!(yield* isDirectory(target)))
            return yield* Effect.fail(new DotfilesError("record does not exist"));
          const editor = yield* validate(() =>
            editorCommand(process.env.VISUAL ?? process.env.EDITOR ?? ""),
          );
          yield* v.stdout(`editing protected workspace ${root}\n`);
          yield* run([...editor, target], {
            stdin: "inherit",
            outputMode: "inherit",
            stderr: "inherit",
          });
          yield* packWorkspace(v, root);
        }),
      (root, exit) =>
        (Exit.isSuccess(exit)
          ? fs.remove(root, { recursive: true })
          : v.stderr(`records: protected workspace retained at ${root}\n`)
        ).pipe(Effect.orDie),
    );
  });
}

function editorCommand(setting: string): string[] {
  const words = split(setting);
  if (!words.length) throw new DotfilesError("VISUAL or EDITOR must name an editor");
  return words;
}

function collectionsWithSourceBodies(v: Vault, value: CollectionSet) {
  return Effect.gen(function* () {
    const updated = structuredClone(value);
    for (const current of records(updated)) {
      const item = current.record;
      for (let variant = -1; variant < (item.variants?.length ?? 0); variant++) {
        const bodies: string[] = [];
        for (const target of item.paths) {
          const path = yield* validate(() =>
            variantSourcePath(v, current, target, variant),
          );
          yield* validateSourceParents(path);
          const label = relative(v.repository, path);
          if (!(yield* isRegular(path)))
            return yield* Effect.fail(
              new DotfilesError(`missing plaintext record: ${label}`),
            );
          bodies.push(yield* readUTF8(path, `plaintext record ${label}`));
        }
        yield* validate(() => {
          const entry = variant < 0 ? item : item.variants?.[variant];
          if (!entry) throw new DotfilesError("missing record variant");
          const unique = new Set(bodies);
          if (unique.size === 2 && unique.has(entry.body)) unique.delete(entry.body);
          if (unique.size !== 1)
            throw new DotfilesError(
              `plaintext copies for ${current.collection} record ${pad(current.index)} contain conflicting edits`,
            );
          const body = unique.values().next().value;
          if (body === undefined)
            throw new DotfilesError("missing plaintext record body");
          entry.body = body;
        });
      }
    }
    yield* validate(() => validateCollections(updated));
    return updated;
  });
}

export function checkMaterialized(v: Vault, value: CollectionSet) {
  return Effect.gen(function* () {
    yield* requireUnpackedMarker(v);
    const sources = yield* validate(() => sourceFiles(v, value));
    yield* validateLocalExcludes(v, [
      ...sources.map((source) => source.path),
      v.searchIgnore,
    ]);
    yield* validateSearchIgnore(v, sources);
    if (!equalCollections(yield* collectionsWithSourceBodies(v, value), value))
      return yield* Effect.fail(
        new DotfilesError(
          "plaintext records differ from the encrypted vault, run `just records pack`",
        ),
      );
  });
}

function concealSourceFiles(v: Vault, sources: SourceFile[]) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const source of sources) {
      yield* validateSourceParents(source.path);
      if (
        !(yield* isRegular(source.path)) ||
        Buffer.compare(yield* fs.readFile(source.path), Buffer.from(source.body)) !== 0
      )
        return yield* Effect.fail(
          new DotfilesError(
            `refusing to remove unverified plaintext record: ${relative(v.repository, source.path)}`,
          ),
        );
    }
    yield* validateSearchIgnore(v, sources);
    yield* requireUnpackedMarker(v);
    yield* clearSearchIgnore(v);
    const removable = [...sources.map((source) => source.path), v.marker];
    for (const path of removable) yield* fs.remove(path);
    for (const directory of new Set(removable.map(dirname))) {
      let current = directory;
      while (current !== v.source && isWithin(v.source, current)) {
        if (!(yield* isDirectory(current)) || !(yield* directoryEmpty(current))) break;
        yield* removeEmptyDirectory(current);
        current = dirname(current);
      }
    }
    const exclude = yield* localExcludePath(v);
    if (yield* isRegular(exclude)) {
      const [content, mode] = yield* readOptionalTextFile(exclude);
      const retained = localExcludeBlock.remove(content).trimEnd();
      yield* replaceTextFile(exclude, retained ? `${retained}\n` : "", mode);
    }
    yield* v.stdout(
      `concealed ${sources.length} plaintext files in the encrypted vault\n`,
    );
  });
}

function runGit(v: Vault, ...args: string[]) {
  return run(["git", "-C", v.repository, ...args], {
    capture: true,
    stdin: "ignore",
  }).pipe(
    Effect.map((result) => result.stdout),
    Effect.mapError(
      (cause) => new DotfilesError(`git command failed: ${cause.message}`),
    ),
  );
}

function localExcludePath(v: Vault) {
  return runGit(v, "rev-parse", "--git-path", "info/exclude").pipe(
    Effect.map((path) => resolve(v.repository, path.trim())),
  );
}

function localExcludeEntries(v: Vault, paths: string[]): string[] {
  return [v.marker, ...paths].map((path) => `/${relative(v.repository, path)}`).sort();
}

function verifyGitExcludes(v: Vault, paths: string[]) {
  return Effect.forEach(
    [...paths, v.marker],
    (path) =>
      runGit(
        v,
        "check-ignore",
        "--quiet",
        "--no-index",
        "--",
        relative(v.repository, path),
      ),
    { discard: true },
  );
}

function planLocalExcludes(v: Vault, paths: string[]) {
  return Effect.gen(function* () {
    const path = yield* localExcludePath(v);
    if (!(yield* isDirectory(dirname(path))))
      return yield* Effect.fail(
        new DotfilesError(`git exclude directory does not exist: ${dirname(path)}`),
      );
    const [content, mode] = yield* readOptionalTextFile(path);
    return {
      path,
      body: localExcludeBlock.replace(content, localExcludeEntries(v, paths)),
      mode,
    };
  });
}

function validateLocalExcludes(v: Vault, paths: string[]) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exclude = yield* localExcludePath(v);
    if (!(yield* isRegular(exclude)))
      return yield* Effect.fail(
        new DotfilesError("missing local Git exclude file, run `just records unpack`"),
      );
    const content = yield* fs.readFileString(exclude);
    if (content !== localExcludeBlock.replace(content, localExcludeEntries(v, paths)))
      return yield* Effect.fail(
        new DotfilesError(
          "local Git exclude block is stale, run `just records unpack`",
        ),
      );
    yield* verifyGitExcludes(v, paths).pipe(
      Effect.mapError(
        () =>
          new DotfilesError(
            "plaintext records are not excluded from Git, run `just records unpack`",
          ),
      ),
    );
  });
}

function searchIgnoreContent(v: Vault, current: string, sources: SourceFile[]): string {
  const entries = sources
    .map(
      (source) =>
        `!/${relative(v.repository, source.path).replace(/[\\*?[\]]/g, "\\$&")}`,
    )
    .sort();
  return `${searchIgnoreBlock.replace(current, entries)}\n`;
}

function planSearchIgnore(v: Vault, sources: SourceFile[]) {
  return Effect.gen(function* () {
    const label = relative(v.repository, v.searchIgnore);
    const tracked = yield* run(
      ["git", "-C", v.repository, "ls-files", "--error-unmatch", "--", label],
      { check: false, stdin: "ignore", outputMode: "discard", stderr: "ignore" },
    );
    if (tracked.code === 0)
      return yield* Effect.fail(
        new DotfilesError(`refusing to modify tracked ripgrep ignore file: ${label}`),
      );
    yield* validateSourceParents(v.searchIgnore);
    if ((yield* pathExists(v.searchIgnore)) && !(yield* isRegular(v.searchIgnore)))
      return yield* Effect.fail(
        new DotfilesError(`ripgrep ignore overlay must be a regular file: ${label}`),
      );
    const [content, mode] = yield* readOptionalTextFile(v.searchIgnore);
    return { body: searchIgnoreContent(v, content, sources), mode };
  });
}

function validateSearchIgnore(v: Vault, sources: SourceFile[]) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* isRegular(v.searchIgnore)))
      return yield* Effect.fail(
        new DotfilesError("missing local ripgrep ignore overlay"),
      );
    const content = yield* fs.readFileString(v.searchIgnore);
    if (content !== searchIgnoreContent(v, content, sources))
      return yield* Effect.fail(
        new DotfilesError(
          "local ripgrep ignore overlay is stale, run `just records unpack`",
        ),
      );
  });
}

function clearSearchIgnore(v: Vault) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* isRegular(v.searchIgnore))) return;
    const [content, mode] = yield* readOptionalTextFile(v.searchIgnore);
    const retained = searchIgnoreBlock.remove(content).trimEnd();
    if (!retained) yield* fs.remove(v.searchIgnore);
    else yield* replaceTextFile(v.searchIgnore, `${retained}\n`, mode);
  });
}

function writeMarker(v: Vault) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = `${marshalJSON({ version: layoutVersion })}\n`;
    if (!(yield* pathExists(v.marker))) return yield* writePrivate(v.marker, content);
    if (!(yield* isRegular(v.marker)))
      return yield* Effect.fail(
        new DotfilesError(`records marker must be a regular file: ${v.marker}`),
      );
    yield* replaceTextFile(v.marker, content, 0o600);
    yield* fs.chmod(v.marker, 0o600);
  });
}

function requireUnpackedMarker(v: Vault) {
  return Effect.gen(function* () {
    if (!(yield* isRegular(v.marker)))
      return yield* Effect.fail(
        new DotfilesError("records are not unpacked, run `just records unpack` first"),
      );
    const content = yield* readUTF8(v.marker, "records marker");
    const marker = yield* validate(() => parseJSON(content, "records marker"));
    if (
      !marker ||
      typeof marker !== "object" ||
      Array.isArray(marker) ||
      Object.keys(marker).some((key) => key !== "version") ||
      !("version" in marker) ||
      marker.version !== layoutVersion
    )
      return yield* Effect.fail(new DotfilesError("unsupported records marker"));
  });
}

function resolveEditorTarget(
  v: Vault,
  target: string,
  value: CollectionSet,
  home: string,
): string {
  const candidate = resolve(target);
  if (
    isWithin(v.repository, candidate) &&
    sourceFiles(v, value).some((source) => candidate === source.path)
  )
    return candidate;
  const normalized = target.startsWith("~/")
    ? target.slice(2)
    : isAbsolute(target) && isWithin(home, target)
      ? relative(home, target)
      : target;
  for (const current of records(value))
    if (current.record.paths.includes(normalized)) return sourcePathFor(v, normalized);
  throw new DotfilesError(`unknown record path: ${target}`);
}

function readOptionalTextFile(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* isRegular(path))) return ["", 0o600] as const;
    return [
      yield* fs.readFileString(path),
      (yield* fs.stat(path)).mode & 0o777,
    ] as const;
  });
}
