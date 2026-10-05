import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "../packages/omp");
const sources = [
  "selectable-terminal-size.patch",
  "ssh-identity-isolation.patch",
  "workspace-isolation.patch",
  "zstd-transfer.patch",
];
const targets = [
  { name: "terminal-size.patch", prefix: "packages/coding-agent/" },
  { name: "tui-terminal-size.patch", prefix: "packages/tui/" },
];
const check = process.argv.includes("--check");

function sections(patch: string): string[] {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((part) => part.startsWith("diff --git "));
}

function sourcePath(section: string): string {
  const match = /^diff --git a\/(\S+) b\/\S+\n/.exec(section);
  if (!match?.[1]) throw new Error("Invalid patch file header");
  return match[1];
}

const patches = (
  await Promise.all(
    sources.map((name) => readFile(join(root, "patches", name), "utf8")),
  )
).flatMap(sections);

for (const target of targets) {
  const path = join(root, "npm-patches", target.name);
  const previous = await readFile(path, "utf8");
  const source = patches
    .filter((section) => sourcePath(section).startsWith(`${target.prefix}src/`))
    .map((section) =>
      section
        .split("\n")
        .filter((line) => !line.startsWith("index "))
        .map((line) =>
          /^(diff --git |--- |\+\+\+ )/.test(line)
            ? line
                .replaceAll(`a/${target.prefix}`, "a/")
                .replaceAll(`b/${target.prefix}`, "b/")
            : line,
        )
        .join("\n"),
    );
  if (!source.length) throw new Error(`No source hunks for ${target.name}`);
  const remaining = new Map(source.map((section) => [sourcePath(section), section]));
  if (remaining.size !== source.length)
    throw new Error(`Overlapping source patches for ${target.name}`);
  const generated = [
    ...sections(previous).flatMap((section) => {
      const file = sourcePath(section);
      // Published declarations have different paths and remain npm-specific
      if (file.startsWith("dist/types/")) return [section];
      if (!file.startsWith("src/"))
        throw new Error(`Unexpected npm-only patch: ${file}`);
      const replacement = remaining.get(file);
      remaining.delete(file);
      return replacement ? [replacement] : [];
    }),
    ...remaining.values(),
  ].join("");
  if (previous === generated) continue;
  if (check) {
    console.error(`${target.name} is stale; run just omp-patches-sync`);
    process.exitCode = 1;
  } else {
    await writeFile(path, generated);
    console.log(`Updated ${target.name}`);
  }
}
