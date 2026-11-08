import { join, posix } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { writeIfChanged, writeJson } from "@dotfiles/core/files";
import { download } from "@dotfiles/core/http";
import { Effect, FileSystem, Schema } from "effect";
import { downloadArchive, readManifest } from "./npm.ts";
import { root } from "./paths.ts";

const npmArchivePrefix = "package/";
const nativePackageScope = "@fallow-cli/";
const companionPackage = "fallow-type-aware";
const launcherMode = 0o755;
const sourceMode = 0o644;

const dependencySchema = Schema.Record(Schema.String, Schema.String);
const manifestSchema = Schema.Struct({
  version: Schema.String,
  bin: dependencySchema,
  engines: dependencySchema,
  dependencies: dependencySchema,
  optionalDependencies: dependencySchema,
});
const sidecar = (name: string) =>
  name === companionPackage || name.startsWith(`@${companionPackage}/`);

type FallowArchive = { path: string; members: Set<string> };

const openFallowArchive = Effect.fn(function* (archive: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const staging = yield* fs.makeTempDirectoryScoped({ prefix: "fallow-vendor-" });
  const path = join(staging, "source.tar.gz");
  yield* fs.writeFile(path, archive);
  const members = new Set(
    (yield* output(["tar", "-tzf", path], { cwd: root }))
      .split("\n")
      .filter((entry) => entry.startsWith(npmArchivePrefix) && !entry.endsWith("/"))
      .map((entry) => entry.slice(npmArchivePrefix.length)),
  );
  return { path, members };
});

const readArchiveMember = Effect.fn(function* (archive: FallowArchive, name: string) {
  if (
    !archive.members.has(name) ||
    posix.normalize(name) !== name ||
    name.startsWith("../") ||
    posix.isAbsolute(name)
  )
    return yield* Effect.fail(
      new DotfilesError(`Missing or unsafe Fallow archive member: ${name}`),
    );
  return (yield* run(["tar", "-xOzf", archive.path, `${npmArchivePrefix}${name}`], {
    cwd: root,
    capture: true,
  })).stdout;
});

const resolveLauncherDependency = Effect.fn(function* (
  archive: FallowArchive,
  name: string,
  specifier: string,
) {
  const resolved = posix.join(posix.dirname(name), specifier);
  const dependency = [
    resolved,
    `${resolved}.js`,
    `${resolved}.cjs`,
    `${resolved}.json`,
    `${resolved}/index.js`,
  ].find((candidate) => archive.members.has(candidate));
  if (!dependency)
    return yield* Effect.fail(
      new DotfilesError(`Unresolved Fallow launcher dependency: ${name}: ${specifier}`),
    );
  return dependency;
});

const readLauncherSources = Effect.fn(function* (
  archive: FallowArchive,
  launchers: Set<string>,
) {
  // Keep the launcher runtime closure, not npm's skills, types, docs or tests
  // Read members without extracting unused package content into the worktree
  const pending = [...launchers, "schema.json", "LICENSE"];
  const sources = new Map<string, string>();
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || sources.has(name)) continue;
    const content = yield* readArchiveMember(archive, name);
    sources.set(name, content);
    if (!launchers.has(name) && !/\.(?:[cm]?js)$/.test(name)) continue;
    for (const match of content.matchAll(
      /(?:\brequire(?:\.resolve)?\s*\(\s*|\b(?:from|import)\s*)["'](\.[^"']+)["']/g,
    )) {
      const specifier = match[1];
      if (!specifier) continue;
      pending.push(yield* resolveLauncherDependency(archive, name, specifier));
    }
  }
  return sources;
});

const removeRetiredLaunchers = Effect.fn(function* (
  directory: string,
  sources: Map<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  // Remove launcher modules retired upstream, without touching other content
  const directories = ["bin", "scripts"];
  for (const relative of directories) {
    const absolute = join(directory, relative);
    if (!(yield* fs.exists(absolute))) continue;
    for (const entry of yield* fs.readDirectory(absolute)) {
      const name = posix.join(relative, entry);
      if ((yield* fs.lstat(join(directory, name))).type === "Directory") {
        directories.push(name);
      } else if (!sources.has(name) && !/\.(?:test|spec)\.[cm]?js$/.test(name)) {
        yield* fs.remove(join(directory, name));
      }
    }
  }
});

const updateSemanticCompanion = Effect.fn(function* (version: string) {
  const path = join(root, "package.json");
  const manifest = yield* readManifest(path);
  const dependencies = yield* Schema.decodeUnknownEffect(dependencySchema)(
    manifest.devDependencies,
  );
  yield* writeJson(path, {
    ...manifest,
    devDependencies: { ...dependencies, [companionPackage]: version },
  });
});

export const updateFallow = Effect.fn(function* () {
  const directory = join(root, "tools/tiling/vendor/fallow");
  const path = join(directory, "package.json");
  const raw = yield* readManifest(path);
  const local = yield* Schema.decodeUnknownEffect(manifestSchema)(raw);
  const metadata = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      version: Schema.String,
      dist: Schema.Struct({ tarball: Schema.String, integrity: Schema.String }),
    }),
  )(
    yield* download(
      `https://registry.npmjs.org/fallow/${encodeURIComponent(local.version)}`,
      (response) => response.json,
    ),
  );
  if (metadata.version !== local.version)
    return yield* Effect.fail(new DotfilesError("Fallow registry version mismatch"));
  const archive = yield* openFallowArchive(
    yield* downloadArchive(metadata.dist, "Fallow"),
  );
  const upstream = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(manifestSchema),
  )(yield* readArchiveMember(archive, "package.json"));
  if (upstream.version !== local.version)
    return yield* Effect.fail(new DotfilesError("Fallow archive version mismatch"));

  const launchers = new Set(Object.values(upstream.bin));
  const sources = yield* readLauncherSources(archive, launchers);

  const native = Object.fromEntries(
    Object.entries(upstream.optionalDependencies).filter(([name]) =>
      name.startsWith(nativePackageScope),
    ),
  );
  if (
    Object.keys(native).length === 0 ||
    Object.values(native).some((version) => version !== local.version)
  )
    return yield* Effect.fail(
      new DotfilesError("Fallow native packages do not match the launcher version"),
    );
  // Preserve independently updated dependency pins, but native packages must
  // match this launcher and the optional Go-backed sidecar stays excluded
  const dependencies = Object.fromEntries(
    Object.entries({ ...upstream.dependencies, ...local.dependencies }).filter(
      ([name]) => !sidecar(name),
    ),
  );
  const optionalDependencies = {
    ...Object.fromEntries(
      Object.entries(upstream.optionalDependencies).filter(
        ([name]) => !name.startsWith(nativePackageScope) && !sidecar(name),
      ),
    ),
    ...Object.fromEntries(
      Object.entries(local.optionalDependencies).filter(
        ([name]) => !name.startsWith(nativePackageScope) && !sidecar(name),
      ),
    ),
    ...native,
  };
  for (const [name, content] of sources)
    yield* writeIfChanged(
      join(directory, name),
      content,
      launchers.has(name) ? launcherMode : sourceMode,
    );

  yield* removeRetiredLaunchers(directory, sources);
  yield* writeJson(path, {
    ...raw,
    private: true,
    version: upstream.version,
    engines: upstream.engines,
    bin: upstream.bin,
    files: [
      ...new Set([...sources.keys()].map((name) => name.split("/")[0] ?? name)),
    ].sort(),
    dependencies,
    optionalDependencies,
  });
  yield* updateSemanticCompanion(upstream.version);
});

export const updatePalette = Effect.fn(function* () {
  // The generator must import the selected palette, not stale node_modules
  yield* run(["bun", "install", "--ignore-scripts", "--frozen-lockfile"], {
    cwd: root,
    capture: true,
  });
  yield* run(["bun", "home/theme/palette/generate.ts"], { cwd: root, capture: true });
});
