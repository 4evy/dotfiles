import { createHash, type Hash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { run as runCommand } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Option, type PlatformError, Schema } from "effect";
import { buildHjemOutput } from "./nix.ts";
import {
  type Entry,
  GeneratorsSchema,
  HooksSchema,
  ManifestSchema,
  PreparedAiManifestSchema,
} from "./schema.ts";

const repository = resolve(import.meta.dir, "../..");
const home = homedir();
const state = join(process.env.XDG_STATE_HOME || join(home, ".local/state"), "hjem");
const action = process.argv[2] || "apply";
const requested = process.argv.slice(3).map((path) => resolve(home, path));
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  HJEM_WORKING_TREE: repository,
  HJEM_HOME_DIR: home,
  HJEM_SOURCE_DIR: join(repository, "home/files"),
  HJEM_ACTIVATING: "1",
  SOPS_AGE_KEY_CACHE: "records",
};

const run = (command: readonly string[], capture = false, cwd = repository) =>
  runCommand(command, {
    cwd,
    env: environment,
    stdin: "inherit",
    capture,
    stderr: "inherit",
  }).pipe(Effect.map((result) => result.stdout.trim()));

const readJson = Effect.fn("readJson")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path);
  return yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (error) => new DotfilesError(`Invalid JSON in ${path}: ${error}`),
  });
});

// Unlike access(), lstat also recognizes dangling managed symlinks
const exists = Effect.fn("exists")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.lstat(path).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error),
    ),
  );
});

function expand(value: string, output: string) {
  return value
    .replaceAll("@HOME@", home)
    .replaceAll("@REPOSITORY@", repository)
    .replaceAll("@OUTPUT@", output);
}

const homeTarget = Effect.fn("homeTarget")(function* (path: string) {
  const target = resolve(home, path);
  if (!target.startsWith(`${home}/`))
    return yield* Effect.fail(new DotfilesError(`Invalid home target: ${path}`));
  return target;
});

const publicFiles = Effect.fn("publicFiles")(function* (output: string) {
  const fs = yield* FileSystem.FileSystem;
  const built = yield* buildHjemOutput(
    repository,
    "hjemHome",
    environment,
    join(output, "public"),
  );
  if (!built)
    return yield* Effect.fail(
      new DotfilesError("Nix did not return a Hjem home output"),
    );
  yield* fs.copyFile(join(built, "hooks.json"), join(output, "hooks.json"));
  const manifest = yield* Schema.decodeUnknownEffect(ManifestSchema)(
    yield* readJson(join(built, "manifest.json")),
  );
  manifest.files = manifest.files.filter(
    (entry) => !entry.requireCommand || Bun.which(entry.requireCommand),
  );
  for (const entry of manifest.files) delete entry.requireCommand;
  const generators = yield* Schema.decodeUnknownEffect(GeneratorsSchema)(
    yield* readJson(join(built, "generators.json")),
  );
  for (const generator of generators) {
    if (generator.systems && !generator.systems.includes(process.platform)) continue;
    const target = yield* homeTarget(generator.target);
    const source = join(output, "files", relative(home, target));
    yield* fs.makeDirectory(dirname(source), { recursive: true, mode: 0o700 });
    let contents = "";
    if (!generator.requireCommand || Bun.which(generator.requireCommand)) {
      const command = generator.command.map((value) => expand(value, output));
      const result = yield* runCommand(command, {
        cwd: repository,
        env: environment,
        capture: true,
        check: false,
        stdin: "ignore",
      });
      if (result.code === 0) contents = result.stdout;
      else if (generator.required)
        return yield* Effect.fail(
          new DotfilesError(
            `Generator for ${generator.target} failed: ${result.stderr.trim()}`,
          ),
        );
      else console.error(`Could not generate optional ${generator.target}`);
    }
    yield* fs.writeFileString(source, contents, { mode: 0o644 });
    // Keep managed permissions independent of the invoking shell's umask
    yield* fs.chmod(source, 0o644);
    manifest.files.push({ type: "symlink", source, target, clobber: true });
  }
  return manifest;
});

const preparedAi = Effect.fn("preparedAi")(function* (
  output: string,
  managesAi: boolean,
) {
  if (!managesAi) return [] as Entry[];
  const fs = yield* FileSystem.FileSystem;
  const directory = join(repository, ".generated/ai-configs");
  const metadata = yield* Schema.decodeUnknownEffect(PreparedAiManifestSchema)(
    yield* readJson(join(directory, "manifest.json")),
  );
  if (metadata.platform && metadata.platform !== process.platform)
    return yield* Effect.fail(
      new DotfilesError("Prepared AI configuration belongs to another platform"),
    );
  const files: Entry[] = [];
  for (const entry of metadata.files) {
    const target = yield* homeTarget(entry.path);
    const original = join(directory, relative(home, target));
    if (entry.type === "symlink") {
      const link = yield* fs.readLink(original);
      files.push({
        type: "symlink",
        source: resolve(dirname(original), link),
        target,
        clobber: true,
      });
    } else {
      const source = join(output, "ai", relative(home, target));
      yield* fs.makeDirectory(dirname(source), { recursive: true, mode: 0o700 });
      yield* fs.copyFile(original, source);
      const executable = ((yield* fs.stat(original)).mode & 0o111) !== 0;
      yield* fs.chmod(
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
});

function selected(target: string) {
  return (
    !requested.length ||
    requested.some((path) => target === path || target.startsWith(`${path}/`))
  );
}

const activeManifest = Effect.fn("activeManifest")(function* () {
  const path = join(state, "dotfiles/current/manifest.json");
  return (yield* exists(path))
    ? yield* Schema.decodeUnknownEffect(ManifestSchema)(yield* readJson(path))
    : undefined;
});

const generationReferenced = Effect.fn("generationReferenced")(function* (
  output: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const visit = (
    directory: string,
  ): Effect.Effect<boolean, PlatformError.PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      if (!(yield* exists(directory))) return false;
      for (const name of yield* fs.readDirectory(directory)) {
        const path = join(directory, name);
        if ((yield* fs.lstat(path)).type === "Directory") {
          if (yield* visit(path)) return true;
        } else if (name.endsWith(".json")) {
          const referenced = yield* Effect.gen(function* () {
            const manifest = yield* Schema.decodeUnknownEffect(ManifestSchema)(
              yield* readJson(path),
            );
            return manifest.files.some(
              (file) => file.source === output || file.source.startsWith(`${output}/`),
            );
          }).pipe(
            // Retain prepared sources when existing state cannot be inspected
            Effect.catch(() => Effect.succeed(true)),
          );
          if (referenced) return true;
        }
      }
      return false;
    });
  return yield* visit(join(state, "dotfiles"));
});

const same = Effect.fn("same")(function* (entry: Entry) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const source = yield* fs.stat(entry.source);
    const target = yield* fs.lstat(entry.target);
    if (entry.type === "symlink" && target.type !== "SymbolicLink") return false;
    if (entry.type === "copy" && target.type === "SymbolicLink") return false;
    if (source.type === "Directory")
      return (yield* fs.readLink(entry.target)) === entry.source;
    const expectedMode = entry.permissions
      ? Number.parseInt(entry.permissions, 8)
      : source.mode & 0o777;
    if (((yield* fs.stat(entry.target)).mode & 0o777) !== expectedMode) return false;
    const [left, right] = yield* Effect.all([
      fs.readFile(entry.source),
      fs.readFile(entry.target),
    ]);
    return (
      left.length === right.length && left.every((byte, index) => byte === right[index])
    );
  }).pipe(
    Effect.catch((error) => {
      const cause = error.reason.cause as NodeJS.ErrnoException | undefined;
      return error.reason._tag === "NotFound" ||
        ["EINVAL", "EISDIR"].includes(cause?.code || "")
        ? Effect.succeed(false)
        : Effect.fail(error);
    }),
  );
});

function fingerprintInput(
  fingerprint: Hash,
  path: string,
  visited = new Set<string>(),
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    fingerprint.update(path);
    if (!(yield* exists(path))) {
      fingerprint.update("missing");
      return;
    }
    const link = yield* fs.lstat(path);
    if (link.type === "SymbolicLink") fingerprint.update(yield* fs.readLink(path));
    const info = yield* fs.stat(path);
    fingerprint.update(String(info.mode & 0o777));
    if (info.type !== "Directory") {
      fingerprint.update(yield* fs.readFile(path));
      return;
    }
    const identity = `${info.dev}:${Option.getOrUndefined(info.ino)}`;
    if (visited.has(identity)) return;
    visited.add(identity);
    for (const name of (yield* fs.readDirectory(path)).sort()) {
      if (["node_modules", "__pycache__", ".git", ".jj"].includes(name)) continue;
      yield* fingerprintInput(fingerprint, join(path, name), visited);
    }
  });
}

const hooks = Effect.fn("hooks")(function* (output: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* Schema.decodeUnknownEffect(HooksSchema)(
    yield* readJson(join(output, "hooks.json")),
  );
  const hashes = join(state, "hook-state");
  yield* fs.makeDirectory(hashes, { recursive: true, mode: 0o700 });
  for (const hook of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const marker = join(hashes, createHash("sha256").update(hook.name).digest("hex"));
    const previous = (yield* exists(marker)) ? yield* fs.readFileString(marker) : "";
    // Script hooks use immutable store paths, argv hooks declare mutable inputs
    const fingerprint = createHash("sha256").update(JSON.stringify(hook.command));
    for (const input of hook.inputs || [])
      yield* fingerprintInput(fingerprint, resolve(repository, input));
    const hash = fingerprint.digest("hex");
    if (hook.onchange && previous === hash) continue;
    if ((process.env.HJEM_DEFER_HOOKS || "").split(",").includes(hook.name)) {
      console.error(`Deferred ${hook.name}, leaving its activation pending`);
      continue;
    }
    console.error(`Applying ${hook.name}`);
    yield* run(hook.command);
    yield* fs.writeFileString(marker, hash, { mode: 0o600 });
  }
});

const main = Effect.fn("applyHome")(function* (managesAi: boolean) {
  const fs = yield* FileSystem.FileSystem;
  if (!["apply", "build", "diff", "status"].includes(action))
    return yield* Effect.fail(
      new DotfilesError("Expected apply, build, diff, or status"),
    );
  yield* fs.makeDirectory(state, { recursive: true, mode: 0o700 });
  const lock = join(state, "dotfiles.lock");
  let generated: string | undefined;
  let activationStarted = false;
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        fs
          .makeDirectory(lock, { mode: 0o700 })
          .pipe(
            Effect.mapError((error) =>
              error.reason._tag === "AlreadyExists"
                ? new DotfilesError(`Another Hjem operation holds ${lock}`)
                : error,
            ),
          ),
        () => fs.remove(lock, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (
            generated &&
            action !== "build" &&
            !activationStarted &&
            !(yield* generationReferenced(generated))
          )
            yield* fs.remove(generated, { recursive: true, force: true });
        }).pipe(Effect.orDie),
      );
      const rendered = join(state, "rendered");
      yield* fs.makeDirectory(rendered, { recursive: true, mode: 0o700 });
      const output = yield* fs.makeTempDirectory({
        directory: rendered,
        prefix: "generation-",
      });
      generated = output;
      if (managesAi && process.env.DOTFILES_AI_PREPARED !== "1")
        yield* run(["bun", "tools/setup/ai/ai.ts", "generate"]);
      const manifest = yield* publicFiles(output);
      const privateText = yield* run(
        [
          "bun",
          "tools/records/main.ts",
          "deploy",
          "--directory",
          join(output, "records"),
        ],
        true,
      );
      const privateJson = yield* Effect.try({
        try: () => JSON.parse(privateText) as unknown,
        catch: (error) => new DotfilesError(`Invalid private manifest: ${error}`),
      });
      const privateManifest =
        yield* Schema.decodeUnknownEffect(ManifestSchema)(privateJson);
      manifest.files.push(
        ...privateManifest.files,
        ...(yield* preparedAi(output, managesAi)),
      );
      const targets = new Set<string>();
      for (const entry of manifest.files) {
        if (targets.has(entry.target))
          return yield* Effect.fail(
            new DotfilesError(`Duplicate Hjem target: ${entry.target}`),
          );
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
            return yield* Effect.fail(
              new DotfilesError(`Circular Hjem alias: ${entry.target}`),
            );
          visited.add(entry.source);
          const source = byTarget.get(entry.source);
          if (!source) break;
          entry.source = source.source;
        }
      }
      const manifestPath = join(output, "manifest.json");
      yield* fs.writeFileString(manifestPath, JSON.stringify(manifest, null, 2), {
        mode: 0o600,
      });
      if (action === "diff" || action === "status") {
        let changed = 0;
        for (const entry of manifest.files) {
          if (!selected(entry.target) || (yield* same(entry))) continue;
          console.log(relative(home, entry.target));
          changed++;
          if (
            action === "diff" &&
            !entry.source.startsWith(join(output, "records")) &&
            !entry.source.startsWith(join(output, "ai"))
          )
            yield* runCommand(
              [
                "diff",
                "-u",
                "--label",
                entry.target,
                "--label",
                entry.target,
                (yield* exists(entry.target)) ? entry.target : "/dev/null",
                entry.source,
              ],
              { check: false, stdin: "inherit", stderr: "inherit" },
            );
        }
        for (const entry of (yield* activeManifest())?.files || []) {
          if (targets.has(entry.target) || !selected(entry.target)) continue;
          console.log(`removed ${relative(home, entry.target)}`);
          changed++;
        }
        console.error(`${changed} managed files differ`);
        return;
      }
      let hjem = Bun.which("hjem");
      if (!hjem) {
        yield* fs.makeDirectory(join(state, "bootstrap"), {
          recursive: true,
          mode: 0o700,
        });
        const result = yield* run(
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
      if (action === "apply" && requested.length)
        return yield* Effect.fail(
          new DotfilesError(
            "Hjem activates the complete home manifest. Use just apply without target arguments",
          ),
        );
      activationStarted = action === "apply";
      yield* run([
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
        yield* fs.remove(join(state, "dotfiles-manifest.json"), { force: true });
        if (managesAi) yield* run(["bun", "tools/setup/ai/ai.ts", "activate"]);
        yield* hooks(output);
      }
    }),
  );
});

const LockSchema = Schema.Struct({
  root: Schema.String,
  nodes: Schema.Record(
    Schema.String,
    Schema.Struct({
      inputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});

runMain(
  Effect.gen(function* () {
    const lockFile = yield* Schema.decodeUnknownEffect(LockSchema)(
      yield* readJson(join(repository, "flake.lock")),
    );
    const managesAi =
      process.platform === "linux" &&
      Boolean(lockFile.nodes[lockFile.root]?.inputs?.ai);
    if (action === "packages-switch" || action === "packages-build") {
      const configuration = yield* buildHjemOutput(
        repository,
        "hjemConfiguration",
        environment,
      );
      yield* run([
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
    } else yield* main(managesAi);
  }),
);
