import { dirname, isAbsolute, join, resolve } from "node:path";
import { run } from "@dotfiles/core/commands";
import { DotfilesError, UsageError } from "@dotfiles/core/errors";
import { Config, Effect, FileSystem, Option, Schema, Stdio, Stream } from "effect";

const recordMetadata = Schema.fromJsonString(
  Schema.Struct({ paths: Schema.NonEmptyArray(Schema.String) }),
);
const styles: Record<string, string> = {
  A: "\u001b[32m",
  D: "\u001b[31m",
  M: "\u001b[36m",
};

function safeRelativePath(value: string): boolean {
  return (
    Boolean(value) &&
    !isAbsolute(value) &&
    value.split("/").every((part) => !["", ".", ".."].includes(part))
  );
}
const regularFile = Effect.fn("jjDiff.regularFile")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.lstat(path).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(false),
    ),
  );
});
const directory = Effect.fn("jjDiff.directory")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(path)) && (yield* fs.stat(path)).type === "Directory";
});
const parseArguments = Effect.fn("jjDiff.parseArguments")(function* (args: string[]) {
  const [format, left, right, repository, width] = args;
  if (args.length !== 5 || !left || !right || !repository || !width)
    return yield* Effect.fail(
      new UsageError("Usage: jj-diff FORMAT LEFT RIGHT DOTFILES_REPOSITORY WIDTH"),
    );
  if (format !== "patch" && format !== "stat")
    return yield* Effect.fail(new UsageError(`Invalid format: ${format}`));
  if (!safeRelativePath(left) || !safeRelativePath(right))
    return yield* Effect.fail(
      new UsageError("Snapshot paths must be safe relative paths"),
    );
  if (!(yield* directory(left)) || !(yield* directory(right)))
    return yield* Effect.fail(new UsageError("Snapshot paths must name directories"));
  if (!(yield* regularFile(join(repository, "Justfile"))))
    return yield* Effect.fail(
      new UsageError("Dotfiles repository must contain a Justfile"),
    );
  if (!/^\d+$/.test(width) || Number(width) < 1 || !Number.isSafeInteger(Number(width)))
    return yield* Effect.fail(new UsageError(`Invalid output width: ${width}`));
  return { format, left, right, repository, width: Number(width) };
});
const recordTarget = Effect.fn("jjDiff.recordTarget")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const parsed = yield* Schema.decodeUnknownEffect(recordMetadata)(
    yield* fs.readFileString(path),
  ).pipe(
    Effect.mapError(
      () => new DotfilesError(`Record metadata has no target path: ${path}`),
    ),
  );
  const target = parsed.paths[0];
  if (!target)
    return yield* Effect.fail(
      new DotfilesError(`Record metadata has no target path: ${path}`),
    );
  if (!safeRelativePath(target))
    return yield* Effect.fail(new DotfilesError(`Unsafe record target: ${target}`));
  return target;
});
const materializeRecords = Effect.fn("jjDiff.materializeRecords")(function* (
  snapshot: string,
  repository: string,
  workspaces: string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const vault = join(snapshot, "secrets/records.yaml");
  if (!(yield* regularFile(vault))) return;
  const encrypted = join(dirname(vault), ".records.yaml.encrypted");
  const encryptedExists = yield* fs.lstat(encrypted).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(false),
    ),
  );
  if (encryptedExists)
    return yield* Effect.fail(
      new DotfilesError(`Temporary encrypted vault already exists: ${encrypted}`),
    );
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      yield* fs.rename(vault, encrypted);
      workspaces.push(vault);
    }),
  );
  yield* run(
    [
      "just",
      "--justfile",
      join(repository, "Justfile"),
      "records",
      "unpack",
      resolve(vault),
    ],
    {
      env: { RECORDS_FILE: resolve(encrypted), RECORDS_REPOSITORY: repository },
      outputMode: "discard",
    },
  );
  yield* fs.remove(encrypted);
  for (const metadata of yield* fs.glob(join(resolve(vault), "*/*/metadata.json"))) {
    if (!(yield* regularFile(metadata))) continue;
    const record = dirname(metadata);
    const body = join(record, "body");
    if (!(yield* fs.exists(body)) || (yield* fs.stat(body)).type !== "File") continue;
    const target = join(record, "target", yield* recordTarget(metadata));
    yield* fs.makeDirectory(dirname(target), { recursive: true });
    yield* fs.rename(body, target);
  }
});
const cleanup = Effect.fn("jjDiff.cleanup")(function* (workspaces: string[]) {
  const fs = yield* FileSystem.FileSystem;
  const failures: string[] = [];
  for (const path of workspaces)
    yield* fs.remove(path, { recursive: true, force: true }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          failures.push(path);
        }),
      ),
    );
  if (failures.length)
    return yield* Effect.fail(
      new DotfilesError(`Failed to remove plaintext workspace: ${failures.join(", ")}`),
    );
});
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
function rewritePaths(patch: string, left: string, right: string): string {
  return lines(patch)
    .map((line) => {
      if (!/^(?:diff --git |--- |\+\+\+ |Binary files )/.test(line)) return line;
      let rendered = line;
      for (const prefix of ["a", "b"])
        for (const snapshot of [left, right])
          rendered = rendered.replaceAll(`${prefix}/${snapshot}/`, `${prefix}/`);
      return rendered;
    })
    .join("");
}
const gitDiff = Effect.fn("jjDiff.gitDiff")(function* (
  left: string,
  right: string,
  color: boolean,
) {
  const result = yield* run(
    [
      "git",
      "--no-pager",
      "-c",
      "color.diff.meta=normal",
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      `--color=${color ? "always" : "never"}`,
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
      left,
      right,
    ],
    { capture: true, check: false },
  );
  if (![0, 1].includes(result.code))
    return yield* Effect.fail(
      new DotfilesError(
        `Failed to generate diff${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
      ),
    );
  return rewritePaths(result.stdout, left, right);
});
function annotateStatuses(patch: string): string {
  let status = "M";
  return lines(patch)
    .map((line) => {
      if (line.startsWith("diff --git ")) status = "M";
      else if (line.startsWith("new file mode ")) status = "A";
      else if (line.startsWith("deleted file mode ")) status = "D";
      if (line.startsWith("--- a/")) return line.replace("--- a/", `--- a/${status} `);
      if (line.startsWith("+++ b/")) return line.replace("+++ b/", `+++ b/${status} `);
      if (line.startsWith("Binary files a/"))
        return line
          .replace("Binary files a/", `Binary files a/${status} `)
          .replace(" and b/", ` and b/${status} `);
      return line;
    })
    .join("");
}
const diffstat = Effect.fn("jjDiff.diffstat")(function* (
  patch: string,
  width: number,
  color: boolean,
) {
  const result = yield* run(
    [
      "diffstat",
      "-E",
      "-p",
      "1",
      "-r",
      "2",
      "-w",
      String(width),
      ...(color ? ["-C"] : []),
    ],
    { capture: true, check: false, input: annotateStatuses(patch) },
  );
  if (result.code !== 0)
    return yield* Effect.fail(
      new DotfilesError(
        `Failed to generate diffstat${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
      ),
    );
  return lines(result.stdout)
    .map((line) => {
      const match = /^ ([AMD]) (.*?)( \|.*)(\n?)$/.exec(line);
      if (!match) return line;
      const [, status, path, suffix, ending] = match;
      return `${color ? styles[status ?? ""] : ""}${status} ${path}${color ? "\u001b[0m" : ""}${suffix}${ending}`;
    })
    .join("");
});
export const jjDiff = Effect.fn("jjDiff")(function* (args: string[]) {
  const fs = yield* FileSystem.FileSystem;
  const stdio = yield* Stdio.Stdio;
  const { format, left, right, repository, width } = yield* parseArguments(args);
  const result = yield* Effect.acquireUseRelease(
    Effect.sync(() => [] as string[]),
    (workspaces) =>
      Effect.gen(function* () {
        const leftVault = join(left, "secrets/records.yaml");
        const rightVault = join(right, "secrets/records.yaml");
        let same = false;
        if ((yield* regularFile(leftVault)) && (yield* regularFile(rightVault))) {
          const leftBytes = yield* fs.readFile(leftVault);
          const rightBytes = yield* fs.readFile(rightVault);
          same =
            leftBytes.length === rightBytes.length &&
            leftBytes.every((byte, index) => byte === rightBytes[index]);
        }
        if (!same) {
          yield* materializeRecords(left, repository, workspaces);
          yield* materializeRecords(right, repository, workspaces);
        }
        const color = Option.isNone(yield* Config.option(Config.String("NO_COLOR")));
        const patch = yield* gitDiff(left, right, color);
        yield* Stream.make(
          format === "patch" ? patch : yield* diffstat(patch, width, color),
        ).pipe(Stream.run(stdio.stdout({ endOnDone: false })));
        return 0;
      }).pipe(Effect.exit),
    cleanup,
  );
  // Cleanup failures take precedence, as they did in the original finally block
  return yield* result;
});
