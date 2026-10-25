#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempDisposableSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { run as runCommand, shellQuote } from "../../lib/typescript/commands.ts";

const root = resolve(import.meta.dir, "../..");
const packageRoot = join(root, "tools/workstation");

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
  add(join(root, "home/theme/palette/palette.json"));
  hash.update(`${Bun.version}:${Bun.revision}:${process.platform}:${process.arch}`);
  return hash.digest("hex");
}

function managedLauncher(launcher: string, name: string, executable: string): boolean {
  const entry = lstatSync(launcher, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink())
    return resolve(dirname(launcher), readlinkSync(launcher)) === executable;
  if (!entry?.isFile()) return false;
  // Recognize only the exact launchers installed before multicall symlinks
  const argument = name === "workstation" ? "" : `${shellQuote(name)} `;
  return (
    readFileSync(launcher, "utf8") ===
    `#!/bin/sh\nexec ${shellQuote(executable)} ${argument}"$@"\n`
  );
}

function useImage(
  fingerprint: string,
  bin: string,
  executable: string,
  stamp: string,
): boolean {
  const imageExecutable = "/usr/bin/workstation";
  const imageStamp = "/usr/share/dotfiles/workstation.sha256";
  if (
    existsSync(imageExecutable) &&
    existsSync(imageStamp) &&
    readFileSync(imageStamp, "utf8").trim() === fingerprint
  ) {
    const commands = run([imageExecutable, "--help"], true).trim().split("\n").slice(1);
    if (!commands.length || commands.some((name) => !/^[a-z][a-z0-9-]*$/.test(name)))
      throw new Error(
        "The image workstation executable returned invalid command names",
      );
    for (const name of ["workstation", ...commands]) {
      const launcher = join(bin, name);
      if (managedLauncher(launcher, name, executable)) rmSync(launcher);
    }
    const localStamp = lstatSync(stamp, { throwIfNoEntry: false });
    if (
      localStamp?.isFile() &&
      /^[a-f0-9]{64}$/.test(readFileSync(stamp, "utf8").trim()) &&
      lstatSync(executable, { throwIfNoEntry: false })?.isFile()
    ) {
      rmSync(executable);
      rmSync(stamp);
    }
    return true;
  }
  return false;
}

function installLaunchers(bin: string, executable: string): void {
  const commands = run([executable, "--help"], true).trim().split("\n").slice(1);
  if (!commands.length || commands.some((name) => !/^[a-z][a-z0-9-]*$/.test(name)))
    throw new Error("The workstation executable returned invalid command names");
  const names = ["workstation", ...commands];
  for (const name of names) {
    const launcher = join(bin, name);
    if (
      lstatSync(launcher, { throwIfNoEntry: false }) &&
      !managedLauncher(launcher, name, executable)
    )
      throw new Error(
        `Refusing to replace unmanaged workstation launcher: ${launcher}`,
      );
  }
  for (const name of names) {
    const launcher = join(bin, name);
    const entry = lstatSync(launcher, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) continue;
    if (entry) rmSync(launcher);
    symlinkSync(executable, launcher);
  }
}

function install(): void {
  if (existsSync("/etc/NIXOS")) return;
  const home = homedir();
  const data = join(
    process.env.XDG_DATA_HOME ?? join(home, ".local/share"),
    "dotfiles/workstation",
  );
  const bin = join(home, ".local/bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(data, "workstation");
  const stamp = join(data, "source.sha256");
  const fingerprint = sourceHash();
  if (useImage(fingerprint, bin, executable, stamp)) return;
  mkdirSync(data, { recursive: true });
  if (
    !existsSync(executable) ||
    !existsSync(stamp) ||
    readFileSync(stamp, "utf8").trim() !== fingerprint
  ) {
    run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"]);
    using workspace = mkdtempDisposableSync(join(data, ".build-"));
    const temporary = workspace.path;
    const output = join(temporary, "workstation");
    // Machine helpers must not load configuration from the caller's project
    run([
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "src/cli.ts",
      "--outfile",
      output,
    ]);
    run([output, "--help"], true);
    renameSync(output, executable);
    writeFileSync(stamp, `${fingerprint}\n`);
  }
  installLaunchers(bin, executable);
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
