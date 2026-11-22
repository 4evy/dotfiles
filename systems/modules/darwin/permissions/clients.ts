import { basename, isAbsolute, join, resolve } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import policy from "@dotfiles/repo/data/macos/permissions";
import { Effect, FileSystem, Schema } from "effect";
import { tccClientTypes } from "./schema.ts";

const codesign = "/usr/bin/codesign";
const plistBuddy = "/usr/libexec/PlistBuddy";
const bundleInfoPlist = "Contents/Info.plist";

export type Client = {
  grantPaths: string[];
  identifier: string;
  type: number;
  requirement: Buffer | null;
  expression: string | undefined;
  bundle: boolean;
  bundleIdentifier: string | undefined;
  grantPermissions: boolean;
};

const caskInventory = Schema.fromJsonString(
  Schema.Struct({
    casks: Schema.Array(
      Schema.Struct({
        token: Schema.String,
        full_token: Schema.String,
        artifacts: Schema.Array(
          Schema.Struct({
            app: Schema.optional(Schema.Array(Schema.Unknown)),
          }),
        ),
      }),
    ),
  }),
);
const programArguments = Schema.fromJsonString(Schema.Array(Schema.String));
const resourceReceipt = Schema.fromJsonString(
  Schema.Struct({ artifact: Schema.Struct({ resources: Schema.String }) }),
);

const compileRequirement = Effect.fn(function* (expression: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "dotfiles-tcc-",
  });
  const file = join(directory, "requirement.bin");
  yield* run(["/usr/bin/csreq", "-r", "-", "-b", file], {
    input: expression,
    capture: true,
  });
  return Buffer.from(yield* fs.readFile(file));
});

const identity = Effect.fn(function* (
  path: string,
  bundle: boolean,
  grantPermissions = true,
) {
  const info = bundle
    ? yield* run(
        [plistBuddy, "-c", "Print :CFBundleIdentifier", join(path, bundleInfoPlist)],
        { capture: true, check: false },
      )
    : undefined;
  const bundleIdentifier = info?.code === 0 ? info.stdout.trim() : undefined;
  const grantPaths = grantPermissions ? [path] : [];
  const requirement = yield* run([codesign, "-d", "-r-", path], {
    capture: true,
    check: false,
  });
  const expression = requirement.stdout.split("designated => ")[1]?.trim();
  if (!expression) {
    if (!requirement.stderr.includes("code object is not signed at all"))
      return yield* Effect.fail(new DotfilesError(`No code identity: ${path}`));
    // Unsigned apps can only be trusted by executable path, not bundle ID
    const executable = bundle
      ? join(
          path,
          "Contents/MacOS",
          (yield* output([
            plistBuddy,
            "-c",
            "Print :CFBundleExecutable",
            join(path, bundleInfoPlist),
          ])).trim(),
        )
      : path;
    console.warn(`Trusting unsigned executable by path: ${executable}`);
    return {
      grantPaths,
      identifier: executable,
      type: tccClientTypes.absolutePath,
      requirement: null,
      grantPermissions,
      expression: undefined,
      bundle,
      bundleIdentifier,
    } satisfies Client;
  }
  // Check executable code, not mutable resources in patched app bundles
  yield* run([codesign, "--verify", "--ignore-resources", path], {
    capture: true,
  });
  // Some system daemon bundles have no CFBundleIdentifier
  const identifier =
    bundle && !bundleIdentifier
      ? requirement.stderr.match(/^Executable=(.+)$/m)?.[1]
      : (bundleIdentifier ?? path);
  if (!identifier)
    return yield* Effect.fail(new DotfilesError(`No executable identity: ${path}`));
  return {
    grantPaths,
    identifier,
    type: bundleIdentifier
      ? tccClientTypes.bundleIdentifier
      : tccClientTypes.absolutePath,
    expression,
    bundle,
    bundleIdentifier,
    grantPermissions,
    requirement: yield* compileRequirement(expression),
  } satisfies Client;
});

type ExpandPath = (path: string) => string;

const homebrewCasks = Effect.fn(function* (expand: ExpandPath, user: string) {
  const fs = yield* FileSystem.FileSystem;
  const brew = [
    "/usr/bin/sudo",
    "-H",
    "-u",
    user,
    "/usr/bin/env",
    "HOMEBREW_NO_AUTO_UPDATE=1",
    policy.applications.homebrew.executable,
  ];
  const declared = new Set<string>();
  for (const file of policy.applications.homebrew.brewfiles) {
    const manifest = expand(file);
    if (!(yield* fs.exists(manifest)))
      return yield* Effect.fail(new DotfilesError(`Missing app manifest: ${manifest}`));
    const casks = yield* output([
      ...brew,
      "bundle",
      "list",
      "--cask",
      "--file",
      manifest,
    ]);
    for (const token of casks.trim().split(/\s+/).filter(Boolean)) declared.add(token);
  }
  const installed = yield* Schema.decodeEffect(caskInventory)(
    yield* output([...brew, "info", "--json=v2", "--cask", "--installed"]),
  );
  return { installed, declared };
});

function applicationArtifact(app: readonly unknown[]): string | undefined {
  const [source, options] = app;
  if (typeof source !== "string") return undefined;
  const target =
    options !== null &&
    typeof options === "object" &&
    "target" in options &&
    typeof options.target === "string"
      ? options.target
      : basename(source);
  if (!target.endsWith(".app")) return undefined;
  return isAbsolute(target)
    ? target
    : join(policy.applications.homebrew.appDirectory, target);
}

const addHomebrewApplications = Effect.fn(function* (
  apps: Map<string, boolean>,
  expand: ExpandPath,
  user: string,
) {
  const { installed, declared } = yield* homebrewCasks(expand, user);
  for (const cask of installed.casks) {
    if (!declared.has(cask.token) && !declared.has(cask.full_token)) continue;
    for (const artifact of cask.artifacts) {
      const target = applicationArtifact(artifact.app ?? []);
      if (target !== undefined) apps.set(target, true);
    }
  }
});

const farstepResources = Effect.fn(function* (
  apps: Map<string, boolean>,
  expand: ExpandPath,
) {
  const fs = yield* FileSystem.FileSystem;
  const packages = new Set(policy.farstep.packages.map(expand));
  const capturePackages = new Set<string>();
  // Activation runs before launchd installs the new plist
  if (process.env.DOTFILES_FARSTEP_PACKAGE)
    capturePackages.add(process.env.DOTFILES_FARSTEP_PACKAGE);
  const suffix = `/${policy.farstep.app}/Contents/MacOS/Farstep`;
  for (const path of policy.farstep.launchAgents) {
    const plist = expand(path);
    if (!(yield* fs.exists(plist))) continue;
    const text = yield* output([
      "/usr/bin/plutil",
      "-extract",
      "ProgramArguments",
      "json",
      "-o",
      "-",
      plist,
    ]);
    const args = yield* Schema.decodeEffect(programArguments)(text);
    const executable = args.find((arg) => isAbsolute(arg) && arg.endsWith(suffix));
    if (!executable) continue;
    const root = executable.slice(0, -suffix.length);
    // Wrapped launch arguments discover the capture app, not additional Sky clients
    (executable === args[0] ? packages : capturePackages).add(root);
  }
  const resources = new Set(policy.sky.resources.map(expand));
  for (const root of packages) {
    capturePackages.add(root);
    const sky = join(root, policy.farstep.sky);
    const receipt = join(sky, policy.farstep.receipt);
    if (!(yield* fs.exists(receipt))) continue;
    const metadata = yield* Schema.decodeEffect(resourceReceipt)(
      yield* fs.readFileString(receipt),
    );
    resources.add(join(sky, metadata.artifact.resources));
  }
  for (const root of capturePackages) apps.set(join(root, policy.farstep.app), true);
  return resources;
});

const mergeIdentity = Effect.fn(function* (existing: Client, client: Client) {
  existing.grantPermissions ||= client.grantPermissions;
  existing.grantPaths.push(...client.grantPaths);
  if (
    client.expression &&
    existing.expression &&
    client.requirement !== null &&
    !existing.requirement?.equals(client.requirement)
  ) {
    existing.expression = `(${existing.expression}) or (${client.expression})`;
    existing.requirement = yield* compileRequirement(existing.expression);
  }
});

const bundleClients = Effect.fn(function* (apps: Map<string, boolean>) {
  const fs = yield* FileSystem.FileSystem;
  const result: Client[] = [];
  const identifiers = new Map<string, Client>();
  for (const [path, grantPermissions] of [...apps].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!(yield* fs.exists(path))) continue;
    const client = yield* identity(path, true, grantPermissions).pipe(
      Effect.catch((error) => {
        console.warn(
          `Skipping app with unusable signing identity: ${path}: ${error.message}`,
        );
        return Effect.succeed(undefined);
      }),
    );
    if (!client) continue;
    const existing = identifiers.get(client.identifier);
    if (existing) {
      yield* mergeIdentity(existing, client);
    } else {
      identifiers.set(client.identifier, client);
      result.push(client);
    }
  }
  return result;
});

const addExecutableClients = Effect.fn(function* (
  result: Client[],
  executables: Set<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  // Path clients need both their stable entry point and current resolved binary
  // Do not trust generic shells/interpreters outside their responsible app
  for (const path of [...executables]) {
    if (!(yield* fs.exists(path))) continue;
    const resolved = yield* fs.realPath(path);
    executables.add(resolved);
  }
  for (const path of executables) {
    if (!(yield* fs.exists(path))) continue;
    result.push(yield* identity(path, false));
  }
});

export const clients = Effect.fn(function* (home: string, uid: string, user: string) {
  const repo = process.env.DOTFILES_REPO ?? resolve(import.meta.dir, "../../../..");
  const expand: ExpandPath = (path) =>
    path.replaceAll("{home}", home).replaceAll("{uid}", uid).replaceAll("{repo}", repo);
  const apps = new Map<string, boolean>(
    policy.applications.targets.map((path) => [expand(path), false]),
  );
  for (const path of policy.applications.bundles) apps.set(expand(path), true);
  yield* addHomebrewApplications(apps, expand, user);
  const resources = yield* farstepResources(apps, expand);
  const executables = new Set(policy.executables.map(expand));
  for (const root of resources) {
    for (const name of policy.sky.apps) apps.set(join(root, name), true);
    for (const name of policy.sky.executables) executables.add(join(root, name));
  }
  const result = yield* bundleClients(apps);
  yield* addExecutableClients(result, executables);
  return result;
});
