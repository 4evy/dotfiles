import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { DotfilesError } from "@dotfiles/core/errors";
import { Effect, FileSystem } from "effect";
import {
  isWithin,
  marshalJSON,
  parseJSONObject,
  pathExists,
  pathInfo,
  replaceTextFile,
  validate,
  validatePathOverlaps,
} from "./files.ts";
import {
  type CollectionSet,
  type RecordItem,
  records,
  type Vault,
  validRelativePath,
} from "./vault.ts";

const deploymentManifestVersion = 3;
const deploymentManifestFilename = ".manifest.json";
const privateFileMode = 0o600;
const privateDirectoryMode = 0o700;
const privateExecutableMode = 0o700;

interface DeploymentFile {
  type: "symlink";
  source: string;
  target: string;
}

interface DeploymentManifest {
  version: typeof deploymentManifestVersion;
  files: DeploymentFile[];
}

interface DeploymentPlan {
  files: { path: string; body: string; mode: number }[];
  manifest: DeploymentManifest;
  encoded: string;
}

export function deploy(v: Vault, directory = "") {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = homedir();
    const host = hostname();
    const state = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
    const root = resolve(directory || join(state, "hjem", "records"));
    if (isWithin("/nix/store", root) || isWithin(v.repository, root))
      return yield* Effect.fail(
        new DotfilesError(
          "runtime records must stay outside the repository and Nix store",
        ),
      );
    const value = yield* v.decryptCollections();
    const system =
      process.platform === "win32"
        ? "windows"
        : process.platform === "sunos"
          ? "solaris"
          : process.platform;
    const plan = yield* validate(() => planDeployment(value, root, home, system, host));
    const manifestPath = join(root, deploymentManifestFilename);
    const prune = yield* validateDeployment(root, manifestPath, plan);
    yield* privateDirectory(root);
    for (const file of plan.files) {
      yield* privateSubdirectories(root, dirname(file.path));
      yield* validateDeploymentFile(root, file.path);
      yield* replaceTextFile(file.path, file.body, file.mode);
    }
    for (const path of prune) {
      // Recheck before unlinking, never recursively remove stale paths
      yield* validateDeploymentFile(root, path);
      yield* fs.remove(path, { force: true });
    }
    yield* validateDeploymentFile(root, manifestPath);
    // Publish the manifest only after atomically replacing file contents
    yield* replaceTextFile(manifestPath, plan.encoded, privateFileMode);
    yield* v.stdout(plan.encoded);
  });
}

function planDeployment(
  value: CollectionSet,
  root: string,
  home: string,
  system: string,
  host: string,
): DeploymentPlan {
  const manifest: DeploymentManifest = {
    version: deploymentManifestVersion,
    files: [],
  };
  const files: DeploymentPlan["files"] = [];
  const destinations = new Set([join(root, deploymentManifestFilename)]);
  for (const { record: item } of records(value)) {
    if (item.systems.length !== 0 && !item.systems.includes(system)) continue;
    const body = bodyFor(item, system, host, home);
    const mode = item.executable ? privateExecutableMode : privateFileMode;
    for (const target of item.paths) {
      if (!validRelativePath(target)) {
        throw new DotfilesError("record target must be a safe relative path");
      }
      const path = join(root, target);
      if (destinations.has(path)) {
        throw new DotfilesError("runtime record destinations must not overlap");
      }
      destinations.add(path);
      files.push({ path, body, mode });
      manifest.files.push({
        type: "symlink",
        source: path,
        target: join(home, target),
      });
    }
  }
  validatePathOverlaps(
    root,
    destinations,
    "runtime record destinations must not overlap",
  );
  return { files, manifest, encoded: `${marshalJSON(manifest)}\n` };
}

function privateDirectory(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* validateDeploymentDirectory(path);
    yield* fs.makeDirectory(path, { recursive: true, mode: privateDirectoryMode });
    if ((yield* fs.realPath(path)) !== path)
      return yield* Effect.fail(
        new DotfilesError("runtime record directories must not contain symlinks"),
      );
    yield* fs.chmod(path, privateDirectoryMode);
  });
}

function privateSubdirectories(root: string, path: string) {
  return Effect.gen(function* () {
    if (!isWithin(root, path))
      return yield* Effect.fail(
        new DotfilesError("runtime record directory escapes its root"),
      );
    const directories: string[] = [];
    for (let current = path; current !== root; current = dirname(current))
      directories.push(current);
    for (const directory of directories.reverse()) yield* privateDirectory(directory);
  });
}

function validateDeploymentDirectory(path: string) {
  return Effect.gen(function* () {
    const directories: string[] = [];
    for (let current = path; ; current = dirname(current)) {
      directories.push(current);
      if (dirname(current) === current) break;
    }
    for (const directory of directories.reverse()) {
      const info = yield* pathInfo(directory);
      if (info !== undefined && info.type !== "Directory")
        return yield* Effect.fail(
          new DotfilesError(
            "runtime record directories must not contain symlinks or non-directories",
          ),
        );
    }
  });
}

function validateDeploymentFile(root: string, path: string) {
  return Effect.gen(function* () {
    if (path === root || !isWithin(root, path))
      return yield* Effect.fail(
        new DotfilesError("runtime record path escapes its root"),
      );
    yield* validateDeploymentDirectory(dirname(path));
    const info = yield* pathInfo(path);
    if (info !== undefined && info.type !== "File")
      return yield* Effect.fail(
        new DotfilesError(`runtime record destination must be a regular file: ${path}`),
      );
  });
}

function validateDeployment(root: string, manifestPath: string, plan: DeploymentPlan) {
  return Effect.gen(function* () {
    yield* validateDeploymentFile(root, manifestPath);
    const retained = new Set<string>();
    for (const file of plan.files) {
      yield* validateDeploymentFile(root, file.path);
      retained.add(file.path);
    }
    if (!(yield* pathExists(manifestPath))) return [];
    const previous = yield* parseJSONObject(
      manifestPath,
      "previous runtime records manifest",
    ).pipe(
      Effect.mapError((error) =>
        error instanceof DotfilesError
          ? new DotfilesError("invalid previous runtime records manifest")
          : error,
      ),
    );
    const sources = yield* validate(() => previousSources(previous, manifestPath));
    for (const source of sources) yield* validateDeploymentFile(root, source);
    return sources.filter((source) => !retained.has(source));
  });
}

function previousSources(
  previous: Record<string, unknown>,
  manifestPath: string,
): string[] {
  if (
    Object.keys(previous).some((key) => key !== "version" && key !== "files") ||
    (previous.version !== undefined && !Number.isInteger(previous.version)) ||
    (previous.files != null && !Array.isArray(previous.files))
  )
    throw new DotfilesError("invalid previous runtime records manifest");
  if (previous.version !== deploymentManifestVersion)
    throw new DotfilesError("unsupported previous runtime records manifest");
  const seen = new Set<string>();
  for (const entry of (previous.files ?? []) as unknown[]) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some(
        (key) => key !== "type" && key !== "source" && key !== "target",
      ) ||
      Object.values(entry).some((field) => typeof field !== "string")
    )
      throw new DotfilesError("invalid previous runtime records manifest");
    const old = entry as Record<string, string>;
    const source = old.source ?? "";
    if (
      old.type !== "symlink" ||
      !isAbsolute(source) ||
      normalize(source) !== source ||
      source === manifestPath ||
      seen.has(source)
    )
      throw new DotfilesError("invalid previous runtime records source");
    seen.add(source);
  }
  return [...seen];
}

function bodyFor(item: RecordItem, system: string, host: string, home: string): string {
  let body = item.body;
  for (const variant of item.variants ?? []) {
    if (variant.system === system && !variant.hostname) body = variant.body;
  }
  for (const variant of item.variants ?? []) {
    if (variant.system === system && (variant.hostname ?? "") === host)
      body = variant.body;
  }
  if (item.render) {
    // Expand the two supported runtime placeholders after variant selection
    body = body.replace(/@HOME@|@HOSTNAME@/g, (placeholder) =>
      placeholder === "@HOME@" ? home : host,
    );
  }
  return body;
}
