import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { output } from "../../lib/typescript/commands.ts";

const root = resolve(import.meta.dir, "../..");
const source = join(root, "dotfiles");
const staging = await mkdtemp(join(tmpdir(), "dotfiles-typecheck-"));
// TypeScript's supported source extensions, including JSX and module variants
const scriptExtensions: Record<string, true> = {
  ".ts": true,
  ".tsx": true,
  ".mts": true,
  ".cts": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".cjs": true,
};

try {
  const discovery = output(
    [
      "git",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "dotfiles/home",
    ],
    { cwd: root },
  );

  // Stage the native home tree so workspace metadata cannot become a target
  const sources = new Map<string, string>();
  for (const file of discovery.split("\0")) {
    if (!file.startsWith("dotfiles/home/")) continue;
    const extension = extname(file);
    // JSON includes imported data and package metadata needed for resolution
    if (!scriptExtensions[extension] && extension !== ".json") continue;
    const target = file.slice("dotfiles/home/".length);
    if (sources.has(target)) throw new Error(`Duplicate staged path: ${target}`);
    const original = join(root, file);
    if (!(await Bun.file(original).exists())) continue;
    sources.set(target, file);
    await mkdir(dirname(join(staging, target)), { recursive: true });
    await copyFile(original, join(staging, target));
  }

  const config = await Bun.file(join(source, "tsconfig.json")).json();
  await Bun.write(
    join(staging, "tsconfig.json"),
    JSON.stringify({
      ...config,
      extends: join(source, "tsconfig.json"),
      include: [],
      files: [...sources.keys()].filter((path) => scriptExtensions[extname(path)]),
    }),
  );
  // Nested runtime dependencies must also be declared in dotfiles/package.json
  await symlink(join(source, "node_modules"), join(staging, "node_modules"), "dir");
  // Keep diagnostics relative even when macOS resolves /var to /private/var

  const compiler = Bun.spawn(
    [
      join(source, "node_modules/.bin/tsrs"),
      "-p",
      ".",
      "--pretty",
      "false",
      ...Bun.argv.slice(2),
    ],
    { cwd: staging, stdout: "pipe", stderr: "inherit" },
  );
  const diagnostics = await new Response(compiler.stdout).text();
  process.stdout.write(
    diagnostics.replace(/^(.+?)(\(\d+,\d+\):)/gm, (line, file, location) =>
      sources.has(file) ? `${sources.get(file)}${location}` : line,
    ),
  );
  process.exitCode = await compiler.exited;
} finally {
  await rm(staging, { recursive: true, force: true });
}
