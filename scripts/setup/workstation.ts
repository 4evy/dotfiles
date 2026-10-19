#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { run as runCommand, shellQuote } from "../../lib/typescript/commands.ts";

const root = resolve(import.meta.dir, "../..");
const packageRoot = join(root, "packages/workstation");

function run(args: string[], capture = false): string {
  return runCommand(args, {
    cwd: packageRoot,
    capture,
    stderr: "inherit",
  }).stdout;
}

function sourceHash(): string {
  const hash = createHash("sha256");
  const add = (path: string): void => {
    hash.update(relative(root, path)).update("\0");
    if (lstatSync(path).isDirectory())
      for (const name of readdirSync(path).sort()) add(join(path, name));
    else hash.update(readFileSync(path));
    hash.update("\0");
  };
  for (const name of ["src", "assets", "package.json", "bun.lock"])
    add(join(packageRoot, name));
  add(join(root, "lib/typescript"));
  add(join(root, "dotfiles/data/palette/palette.json"));
  hash.update(`${Bun.version}:${Bun.revision}:${process.platform}:${process.arch}`);
  return hash.digest("hex");
}

function install(): void {
  if (existsSync("/etc/NIXOS")) return;
  const home = homedir();
  const data = join(
    process.env.XDG_DATA_HOME ?? join(home, ".local/share"),
    "dotfiles/workstation",
  );
  const bin = join(home, ".local/bin");
  mkdirSync(data, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const executable = join(data, "workstation");
  const stamp = join(data, "source.sha256");
  const fingerprint = sourceHash();
  if (
    !existsSync(executable) ||
    !existsSync(stamp) ||
    readFileSync(stamp, "utf8").trim() !== fingerprint
  ) {
    run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"]);
    const temporary = mkdtempSync(join(data, ".build-"));
    try {
      const output = join(temporary, "workstation");
      run([process.execPath, "build", "--compile", "src/cli.ts", "--outfile", output]);
      run([output, "--help"], true);
      renameSync(output, executable);
      writeFileSync(stamp, `${fingerprint}\n`);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const commands = run([executable, "--help"], true).trim().split("\n").slice(1);
  if (!commands.length || commands.some((name) => !/^[a-z][a-z0-9-]*$/.test(name)))
    throw new Error("The workstation executable returned invalid command names");
  for (const name of ["workstation", ...commands]) {
    const launcher = join(bin, name);
    if (lstatSync(launcher, { throwIfNoEntry: false })?.isSymbolicLink())
      rmSync(launcher);
    const argument = name === "workstation" ? "" : `${shellQuote(name)} `;
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${shellQuote(executable)} ${argument}"$@"\n`,
    );
    chmodSync(launcher, 0o755);
  }
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).includes("--fingerprint")) console.log(sourceHash());
    else install();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
