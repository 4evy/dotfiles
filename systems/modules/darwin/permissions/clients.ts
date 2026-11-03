import { basename, isAbsolute, join, resolve } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import policy from "@dotfiles/repo/data/macos/permissions";
import { Effect, FileSystem, Schema } from "effect";

export type Client = {
  path: string;
  identifier: string;
  type: number;
  requirement: Buffer | null;
  expression: string | undefined;
  bundle: boolean;
  bundleIdentifier: string | undefined;
  grantPermissions: boolean;
};

const attempt = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (cause) => new DotfilesError(String(cause)),
  });
const compileRequirement = Effect.fn(function* (expression: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-tcc-" });
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
        [
          "/usr/libexec/PlistBuddy",
          "-c",
          "Print :CFBundleIdentifier",
          join(path, "Contents/Info.plist"),
        ],
        { capture: true, check: false },
      )
    : undefined;
  const bundleIdentifier = info?.code === 0 ? info.stdout.trim() : undefined;
  const requirement = yield* run(["/usr/bin/codesign", "-d", "-r-", path], {
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
            "/usr/libexec/PlistBuddy",
            "-c",
            "Print :CFBundleExecutable",
            join(path, "Contents/Info.plist"),
          ])).trim(),
        )
      : path;
    console.warn(`Trusting unsigned executable by path: ${executable}`);
    return {
      path: executable,
      identifier: executable,
      type: 1,
      requirement: null,
      grantPermissions,
      expression: undefined,
      bundle,
      bundleIdentifier,
    } satisfies Client;
  }
  // Check executable code, not mutable resources in patched app bundles
  yield* run(["/usr/bin/codesign", "--verify", "--ignore-resources", path], {
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
    path,
    identifier,
    type: bundleIdentifier ? 0 : 1,
    expression,
    bundle,
    bundleIdentifier,
    grantPermissions,
    requirement: yield* compileRequirement(expression),
  } satisfies Client;
});

export const clients = Effect.fn(function* (home: string, uid: string, user: string) {
  const fs = yield* FileSystem.FileSystem;
  const repo = process.env.DOTFILES_REPO ?? resolve(import.meta.dir, "../../../..");
  const expand = (path: string) =>
    path.replaceAll("{home}", home).replaceAll("{uid}", uid).replaceAll("{repo}", repo);
  const apps = new Map<string, boolean>(
    policy.applications.targets.map((path) => [expand(path), false]),
  );
  for (const path of policy.applications.bundles) apps.set(expand(path), true);
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
  const text = yield* output([...brew, "info", "--json=v2", "--cask", "--installed"]);
  const installed = yield* Schema.decodeUnknownEffect(
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
  )(yield* attempt(() => JSON.parse(text)));
  for (const cask of installed.casks) {
    if (!declared.has(cask.token) && !declared.has(cask.full_token)) continue;
    for (const artifact of cask.artifacts) {
      const [source, options] = artifact.app ?? [];
      if (typeof source !== "string") continue;
      const target =
        options !== null &&
        typeof options === "object" &&
        "target" in options &&
        typeof options.target === "string"
          ? options.target
          : basename(source);
      if (!target.endsWith(".app")) continue;
      apps.set(
        isAbsolute(target)
          ? target
          : join(policy.applications.homebrew.appDirectory, target),
        true,
      );
    }
  }
  const packages = new Set(policy.farstep.packages.map(expand));
  for (const path of policy.farstep.launchAgents) {
    const plist = expand(path);
    if (!(yield* fs.exists(plist))) continue;
    const executable = (yield* output([
      "/usr/libexec/PlistBuddy",
      "-c",
      "Print :ProgramArguments:0",
      plist,
    ])).trim();
    const marker = executable.indexOf(`/${policy.farstep.app}/`);
    if (marker > 0) packages.add(executable.slice(0, marker));
  }
  const resources = new Set(policy.sky.resources.map(expand));
  for (const root of packages) {
    apps.set(join(root, policy.farstep.app), true);
    const sky = join(root, policy.farstep.sky);
    const receipt = join(sky, policy.farstep.receipt);
    if (!(yield* fs.exists(receipt))) continue;
    const text = yield* fs.readFileString(receipt);
    const metadata = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        artifact: Schema.Struct({ resources: Schema.String }),
      }),
    )(yield* attempt(() => JSON.parse(text)));
    resources.add(join(sky, metadata.artifact.resources));
  }
  const executables = new Set(policy.executables.map(expand));
  for (const root of resources) {
    for (const name of policy.sky.apps) apps.set(join(root, name), true);
    for (const name of policy.sky.executables) executables.add(join(root, name));
  }
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
      existing.grantPermissions ||= client.grantPermissions;
      if (
        client.expression &&
        existing.expression &&
        client.requirement !== null &&
        !existing.requirement?.equals(client.requirement)
      ) {
        existing.expression = `(${existing.expression}) or (${client.expression})`;
        existing.requirement = yield* compileRequirement(existing.expression);
      }
      continue;
    }
    identifiers.set(client.identifier, client);
    result.push(client);
  }
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
  return result;
});
