import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { buildHjemOutput } from "./nix.ts";

type Entry = {
  type: "symlink" | "copy";
  source: string;
  target: string;
  clobber?: boolean;
  permissions?: string;
  requireCommand?: string;
};
type Manifest = { version: number; files: Entry[] };
type Hook = {
  source: string;
  onchange: boolean;
  name: string;
  inputs?: string[];
};
type Generator = {
  target: string;
  command: string[];
  systems?: string[];
  requireCommand?: string;
  required?: boolean;
};

const repository = resolve(import.meta.dir, "../..");
const home = homedir();
const state = join(process.env.XDG_STATE_HOME || join(home, ".local/state"), "hjem");
const cache = join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "hjem");
const action = process.argv[2] || "apply";
const requested = process.argv.slice(3).map((path) => resolve(home, path));
const lockFile = (await Bun.file(join(repository, "flake.lock")).json()) as {
  root: string;
  nodes: Record<string, { inputs?: Record<string, unknown> }>;
};
const managesAi =
  process.platform === "linux" && Boolean(lockFile.nodes[lockFile.root]?.inputs?.ai);
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  HJEM_WORKING_TREE: repository,
  HJEM_HOME_DIR: home,
  HJEM_SOURCE_DIR: join(repository, "dotfiles/home"),
  HJEM_ACTIVATING: "1",
  GOWORK: "off",
  SOPS_AGE_KEY_CACHE: "records",
};

async function run(command: string[], capture = false, cwd = repository) {
  const child = Bun.spawn(command, {
    cwd,
    env: environment,
    stdin: "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const output = capture ? await new Response(child.stdout).text() : "";
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${command[0]}`);
  return output.trim();
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function buildTool(name: string, source: string) {
  const binary = join(cache, "bin", name);
  await mkdir(dirname(binary), { recursive: true, mode: 0o700 });
  await run(["go", "build", "-o", binary, "."], false, join(repository, source));
  return binary;
}

function expand(value: string, output: string) {
  return value
    .replaceAll("@HOME@", home)
    .replaceAll("@REPOSITORY@", repository)
    .replaceAll("@OUTPUT@", output);
}

function homeTarget(path: string) {
  const target = resolve(home, path);
  if (!target.startsWith(`${home}/`)) throw new Error(`Invalid home target: ${path}`);
  return target;
}

async function publicFiles(output: string): Promise<Manifest> {
  const built = await buildHjemOutput(
    repository,
    "hjemHome",
    environment,
    join(output, "public"),
  );
  if (!built) throw new Error("Nix did not return a Hjem home output");
  await copyFile(join(built, "hooks.json"), join(output, "hooks.json"));
  const manifest = (await Bun.file(join(built, "manifest.json")).json()) as Manifest;
  manifest.files = manifest.files.filter(
    (entry) => !entry.requireCommand || Bun.which(entry.requireCommand),
  );
  for (const entry of manifest.files) delete entry.requireCommand;
  const generators = (await Bun.file(
    join(built, "generators.json"),
  ).json()) as Generator[];
  for (const generator of generators) {
    if (generator.systems && !generator.systems.includes(process.platform)) continue;
    const target = homeTarget(generator.target);
    const source = join(output, "files", relative(home, target));
    await mkdir(dirname(source), { recursive: true, mode: 0o700 });
    let contents = "";
    if (!generator.requireCommand || Bun.which(generator.requireCommand)) {
      const command = generator.command.map((value) => expand(value, output));
      const child = Bun.spawn(command, {
        cwd: repository,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [body, error] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if ((await child.exited) === 0) contents = body;
      else if (generator.required)
        throw new Error(`Generator for ${generator.target} failed: ${error.trim()}`);
      else console.error(`Could not generate optional ${generator.target}`);
    }
    await writeFile(source, contents, { mode: 0o644 });
    // Keep managed permissions independent of the invoking shell's umask
    await chmod(source, 0o644);
    manifest.files.push({ type: "symlink", source, target, clobber: true });
  }
  return manifest;
}

async function preparedAi(output: string): Promise<Entry[]> {
  if (!managesAi) return [];
  const directory = join(repository, ".generated/ai-configs");
  const metadata = (await Bun.file(join(directory, "manifest.json")).json()) as {
    platform?: string;
    files: { path: string; private?: boolean; type?: string }[];
  };
  if (metadata.platform && metadata.platform !== process.platform)
    throw new Error("Prepared AI configuration belongs to another platform");
  const files: Entry[] = [];
  for (const entry of metadata.files) {
    const target = homeTarget(entry.path);
    const original = join(directory, relative(home, target));
    if (entry.type === "symlink") {
      const link = await readlink(original);
      files.push({
        type: "symlink",
        source: resolve(dirname(original), link),
        target,
        clobber: true,
      });
    } else {
      const source = join(output, "ai", relative(home, target));
      await mkdir(dirname(source), { recursive: true, mode: 0o700 });
      await copyFile(original, source);
      const executable = ((await stat(original)).mode & 0o111) !== 0;
      await chmod(
        source,
        entry.private ? (executable ? 0o700 : 0o600) : executable ? 0o755 : 0o644,
      );
      files.push({
        type: entry.private ? "copy" : "symlink",
        source,
        target,
        clobber: true,
        ...(entry.private ? { permissions: executable ? "0700" : "0600" } : {}),
      });
    }
  }
  return files;
}

function selected(target: string) {
  return (
    !requested.length ||
    requested.some((path) => target === path || target.startsWith(`${path}/`))
  );
}

async function activeManifest(): Promise<Manifest | undefined> {
  const path = join(state, "dotfiles/current/manifest.json");
  return (await exists(path)) ? ((await Bun.file(path).json()) as Manifest) : undefined;
}

async function generationReferenced(output: string): Promise<boolean> {
  async function visit(directory: string): Promise<boolean> {
    if (!(await exists(directory))) return false;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (await visit(path)) return true;
      } else if (entry.name.endsWith(".json")) {
        try {
          const manifest = (await Bun.file(path).json()) as Partial<Manifest>;
          if (
            manifest.files?.some(
              (file) => file.source === output || file.source.startsWith(`${output}/`),
            )
          )
            return true;
        } catch {
          // Retain prepared sources when existing state cannot be inspected
          return true;
        }
      }
    }
    return false;
  }
  return visit(join(state, "dotfiles"));
}

async function same(entry: Entry) {
  try {
    const source = await stat(entry.source);
    const target = await lstat(entry.target);
    if (entry.type === "symlink" && !target.isSymbolicLink()) return false;
    if (entry.type === "copy" && target.isSymbolicLink()) return false;
    if (source.isDirectory()) {
      return (await readlink(entry.target)) === entry.source;
    }
    const expectedMode = entry.permissions
      ? Number.parseInt(entry.permissions, 8)
      : source.mode & 0o777;
    if (((await stat(entry.target)).mode & 0o777) !== expectedMode) return false;
    return (await readFile(entry.source)).equals(await readFile(entry.target));
  } catch (error) {
    if (
      ["ENOENT", "EINVAL", "EISDIR"].includes(
        (error as NodeJS.ErrnoException).code || "",
      )
    )
      return false;
    throw error;
  }
}

async function fingerprintInput(
  fingerprint: ReturnType<typeof createHash>,
  path: string,
  visited = new Set<string>(),
) {
  fingerprint.update(path);
  if (!(await exists(path))) {
    fingerprint.update("missing");
    return;
  }
  const link = await lstat(path);
  if (link.isSymbolicLink()) fingerprint.update(await readlink(path));
  const info = await stat(path);
  fingerprint.update(String(info.mode & 0o777));
  if (!info.isDirectory()) {
    fingerprint.update(await readFile(path));
    return;
  }
  const identity = `${info.dev}:${info.ino}`;
  if (visited.has(identity)) return;
  visited.add(identity);
  for (const name of (await readdir(path)).sort()) {
    if (["node_modules", "__pycache__", ".git", ".jj"].includes(name)) continue;
    await fingerprintInput(fingerprint, join(path, name), visited);
  }
}

async function hooks(output: string) {
  const entries = (await Bun.file(join(output, "hooks.json")).json()) as Hook[];
  const hashes = join(state, "hook-state");
  await mkdir(hashes, { recursive: true, mode: 0o700 });
  for (const hook of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const marker = join(hashes, createHash("sha256").update(hook.name).digest("hex"));
    const previous = (await exists(marker)) ? await readFile(marker, "utf8") : "";
    const fingerprint = createHash("sha256").update(await readFile(hook.source));
    for (const input of hook.inputs || []) {
      await fingerprintInput(fingerprint, resolve(repository, input));
    }
    const hash = fingerprint.digest("hex");
    if (hook.onchange && previous === hash) continue;
    if ((process.env.HJEM_DEFER_HOOKS || "").split(",").includes(hook.name)) {
      console.error(`Deferred ${hook.name}, leaving its activation pending`);
      continue;
    }
    console.error(`Applying ${hook.name}`);
    await run([hook.source]);
    await writeFile(marker, hash, { mode: 0o600 });
  }
}

async function main() {
  if (!["apply", "build", "diff", "status"].includes(action))
    throw new Error("Expected apply, build, diff, or status");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const lock = join(state, "dotfiles.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Another Hjem operation holds ${lock}`);
    throw error;
  }
  let generated: string | undefined;
  let activationStarted = false;
  try {
    const records = await buildTool("hjem-records", "packages/records/cmd");
    const rendered = join(state, "rendered");
    await mkdir(rendered, { recursive: true, mode: 0o700 });
    const output = await mkdtemp(join(rendered, "generation-"));
    generated = output;
    if (managesAi && process.env.DOTFILES_AI_PREPARED !== "1")
      await run(["bun", "scripts/setup/ai/ai.ts", "generate"]);
    const manifest = await publicFiles(output);
    const privateManifest = JSON.parse(
      await run([records, "deploy", "--directory", join(output, "records")], true),
    ) as Manifest;
    manifest.files.push(...privateManifest.files, ...(await preparedAi(output)));
    const targets = new Set<string>();
    for (const entry of manifest.files) {
      if (targets.has(entry.target))
        throw new Error(`Duplicate Hjem target: ${entry.target}`);
      targets.add(entry.target);
      entry.clobber = true;
    }
    // Resolve aliases to prepared sources so activation order cannot break links
    const byTarget = new Map(manifest.files.map((entry) => [entry.target, entry]));
    for (const entry of manifest.files) {
      if (entry.type !== "symlink") continue;
      entry.source = resolve(entry.source);
      const visited = new Set([entry.target]);
      while (byTarget.has(entry.source)) {
        if (visited.has(entry.source))
          throw new Error(`Circular Hjem alias: ${entry.target}`);
        visited.add(entry.source);
        const source = byTarget.get(entry.source);
        if (!source) break;
        entry.source = source.source;
      }
    }
    const manifestPath = join(output, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    if (action === "diff" || action === "status") {
      let changed = 0;
      for (const entry of manifest.files) {
        if (!selected(entry.target)) continue;
        if (await same(entry)) continue;
        console.log(relative(home, entry.target));
        changed++;
        if (
          action === "diff" &&
          !entry.source.startsWith(join(output, "records")) &&
          !entry.source.startsWith(join(output, "ai"))
        ) {
          const diff = Bun.spawn(
            [
              "diff",
              "-u",
              "--label",
              entry.target,
              "--label",
              entry.target,
              (await exists(entry.target)) ? entry.target : "/dev/null",
              entry.source,
            ],
            { stdout: "inherit", stderr: "inherit" },
          );
          await diff.exited;
        }
      }
      for (const entry of (await activeManifest())?.files || []) {
        if (targets.has(entry.target) || !selected(entry.target)) continue;
        console.log(`removed ${relative(home, entry.target)}`);
        changed++;
      }
      console.error(`${changed} managed files differ`);
      return;
    }
    let hjem = Bun.which("hjem");
    if (!hjem) {
      await mkdir(join(state, "bootstrap"), { recursive: true, mode: 0o700 });
      const result = await run(
        [
          "nix",
          "build",
          `${repository}#hjem`,
          "--out-link",
          join(state, "bootstrap/hjem"),
          "--print-out-paths",
        ],
        true,
      );
      hjem = join(result.split("\n").at(-1) || "", "bin/hjem");
    }
    if (action === "apply" && requested.length) {
      throw new Error(
        "Hjem activates the complete home manifest. Use just apply without target arguments",
      );
    }
    activationStarted = action === "apply";
    await run([
      hjem,
      "standalone",
      action === "apply" ? "switch" : "build",
      "--manifest",
      manifestPath,
      "--state-dir",
      join(state, "dotfiles"),
      "--impure",
    ]);
    if (action === "apply") {
      await rm(join(state, "dotfiles-manifest.json"), { force: true });
      if (managesAi) await run(["bun", "scripts/setup/ai/ai.ts", "activate"]);
      await hooks(output);
    }
  } finally {
    try {
      if (
        generated &&
        action !== "build" &&
        !activationStarted &&
        !(await generationReferenced(generated))
      )
        await rm(generated, { recursive: true, force: true });
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

if (action === "packages-switch" || action === "packages-build") {
  const configuration = await buildHjemOutput(
    repository,
    "hjemConfiguration",
    environment,
  );
  await run([
    "nix",
    "run",
    `${repository}#hjem`,
    "--",
    "standalone",
    action.slice("packages-".length),
    "--config",
    configuration,
    "--impure",
  ]);
} else {
  await main();
}
