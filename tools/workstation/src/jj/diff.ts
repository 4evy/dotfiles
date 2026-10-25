import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as v from "valibot";
import { run } from "../../../../lib/typescript/commands.ts";
import { DotfilesError, UsageError } from "../../../../lib/typescript/errors.ts";

const recordMetadata = v.pipe(
  v.custom<Record<string, unknown>>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  ),
  v.object({ paths: v.pipe(v.array(v.string()), v.minLength(1)) }),
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
function regularFile(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}
function directory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
function parseArguments(args: string[]): {
  format: "patch" | "stat";
  left: string;
  right: string;
  repository: string;
  width: number;
} {
  const [format, left, right, repository, width] = args;
  if (args.length !== 5 || !left || !right || !repository || !width)
    throw new UsageError("Usage: jj-diff FORMAT LEFT RIGHT DOTFILES_REPOSITORY WIDTH");
  if (format !== "patch" && format !== "stat")
    throw new UsageError(`Invalid format: ${format}`);
  if (!safeRelativePath(left) || !safeRelativePath(right))
    throw new UsageError("Snapshot paths must be safe relative paths");
  if (!directory(left) || !directory(right))
    throw new UsageError("Snapshot paths must name directories");
  if (!regularFile(join(repository, "Justfile")))
    throw new UsageError("Dotfiles repository must contain a Justfile");
  if (!/^\d+$/.test(width) || Number(width) < 1 || !Number.isSafeInteger(Number(width)))
    throw new UsageError(`Invalid output width: ${width}`);
  return { format, left, right, repository, width: Number(width) };
}
function recordTarget(path: string): string {
  const parsed = v.safeParse(recordMetadata, JSON.parse(readFileSync(path, "utf8")));
  const target = parsed.success ? parsed.output.paths[0] : undefined;
  if (!target) throw new DotfilesError(`Record metadata has no target path: ${path}`);
  if (!safeRelativePath(target))
    throw new DotfilesError(`Unsafe record target: ${target}`);
  return target;
}
function materializeRecords(
  snapshot: string,
  repository: string,
  workspaces: string[],
): void {
  const vault = join(snapshot, "secrets/records.yaml");
  if (!regularFile(vault)) return;
  const encrypted = join(dirname(vault), ".records.yaml.encrypted");
  if (lstatSync(encrypted, { throwIfNoEntry: false }))
    throw new DotfilesError(`Temporary encrypted vault already exists: ${encrypted}`);
  renameSync(vault, encrypted);
  workspaces.push(vault);
  run(
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
  rmSync(encrypted);
  for (const metadata of new Bun.Glob("*/*/metadata.json").scanSync({
    cwd: vault,
    absolute: true,
  })) {
    if (!regularFile(metadata)) continue;
    const record = dirname(metadata);
    const body = join(record, "body");
    if (!existsSync(body) || !statSync(body).isFile()) continue;
    const target = join(record, "target", recordTarget(metadata));
    mkdirSync(dirname(target), { recursive: true });
    renameSync(body, target);
  }
}
function cleanup(workspaces: string[]): void {
  const failures: string[] = [];
  for (const path of workspaces) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      failures.push(path);
    }
  }
  if (failures.length)
    throw new DotfilesError(
      `Failed to remove plaintext workspace: ${failures.join(", ")}`,
    );
}
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
function gitDiff(left: string, right: string, color: boolean): string {
  const result = run(
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
    throw new DotfilesError(
      `Failed to generate diff${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
    );
  return rewritePaths(result.stdout, left, right);
}
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
function diffstat(patch: string, width: number, color: boolean): string {
  const result = run(
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
    throw new DotfilesError(
      `Failed to generate diffstat${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
    );
  return lines(result.stdout)
    .map((line) => {
      const match = /^ ([AMD]) (.*?)( \|.*)(\n?)$/.exec(line);
      if (!match) return line;
      const [, status, path, suffix, ending] = match;
      return `${color ? styles[status ?? ""] : ""}${status} ${path}${color ? "\u001b[0m" : ""}${suffix}${ending}`;
    })
    .join("");
}
export function jjDiff(args: string[]): number {
  const { format, left, right, repository, width } = parseArguments(args);
  const workspaces: string[] = [];
  try {
    const leftVault = join(left, "secrets/records.yaml");
    const rightVault = join(right, "secrets/records.yaml");
    const same =
      regularFile(leftVault) &&
      regularFile(rightVault) &&
      readFileSync(leftVault).equals(readFileSync(rightVault));
    if (!same) {
      materializeRecords(left, repository, workspaces);
      materializeRecords(right, repository, workspaces);
    }
    const color = process.env.NO_COLOR === undefined;
    const patch = gitDiff(left, right, color);
    process.stdout.write(format === "patch" ? patch : diffstat(patch, width, color));
  } finally {
    cleanup(workspaces);
  }
  return 0;
}
