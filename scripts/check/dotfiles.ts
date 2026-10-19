import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const source = join(root, "dotfiles");
const staging = await mkdtemp(join(tmpdir(), "dotfiles-typecheck-"));

try {
  const discovery = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "dotfiles",
    ],
    { cwd: root },
  );
  if (discovery.exitCode !== 0) {
    throw new Error(discovery.stderr.toString());
  }

  // Stage the native home tree so workspace metadata cannot become a target
  const sources = new Map<string, string>();
  for (const file of discovery.stdout.toString().split("\0")) {
    if (!file.startsWith("dotfiles/home/")) continue;
    if (!/\.(?:[cm]?[jt]sx?|json)$/.test(file)) continue;
    if (file === "dotfiles/tsconfig.json") continue;
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
      files: [...sources.keys()].filter((path) => /\.[cm]?[jt]sx?$/.test(path)),
    }),
  );
  await symlink(join(source, "node_modules"), join(staging, "node_modules"), "dir");

  const compiler = Bun.spawn(
    [
      join(source, "node_modules/.bin/tsc"),
      "-p",
      staging,
      "--pretty",
      "false",
      ...Bun.argv.slice(2),
    ],
    { cwd: staging, stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(compiler.stdout).text();
  process.stdout.write(
    output.replace(/^(.+?)(\(\d+,\d+\):)/gm, (line, file, location) =>
      sources.has(file) ? `${sources.get(file)}${location}` : line,
    ),
  );
  process.exitCode = await compiler.exited;
} finally {
  await rm(staging, { recursive: true, force: true });
}
