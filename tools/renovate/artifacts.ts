import { join } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { writeIfChanged, writeJson } from "@dotfiles/core/files";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Schema } from "effect";
import workspace from "../../package.json" with { type: "json" };
import {
  updateBrowser,
  updateBunBootstrap,
  updateHomebrewBootstrap,
  updateMise,
  updateReleaseAssets,
} from "./checksums.ts";
import { updateNixPackage } from "./nix.ts";
import { readManifest } from "./npm.ts";
import { updateOmpDependencies } from "./omp.ts";
import { updateRenovatePatch } from "./patch.ts";
import { root } from "./paths.ts";
import { updatePalette } from "./vendor.ts";

const chatgptDirectory = "home/files/.local/share/nix/chatgpt";
const chatgptPackagePath = `${chatgptDirectory}/package.nix`;
const spectrumSoftwareRecipe = "systems/spectrum/recipes/spectrum/modules/software.yml";

const changedPaths = Effect.fn(function* () {
  const paths = yield* output(["git", "diff", "HEAD", "--name-only", "-z"], {
    cwd: root,
  });
  return new Set(paths.split("\0").filter(Boolean));
});

const updatePins = Effect.fn(function* (changed: Set<string>) {
  const pinUpdates = [
    { input: ".github/renovate/package.json", update: updateRenovatePatch },
    { input: "tools/setup/setup.sh", update: updateBunBootstrap },
    { input: "tools/setup/setup.ts", update: updateHomebrewBootstrap },
    {
      input: "packages/rex/sources.json",
      update: () => updateNixPackage("rex"),
    },
    {
      input: "packages/super-engineering/sources.json",
      update: () => updateNixPackage("super-engineering"),
    },
    {
      input: "nix/overlays/upstream/upstream.nix",
      update: () =>
        run(["nix", "run", ".#update-bun", "--", "--version=skip"], {
          cwd: root,
          capture: true,
        }),
    },
    {
      input: "nix/overlays/applications.nix",
      update: () =>
        run(["nix", "run", ".#update-helium-darwin", "--", "--version=skip"], {
          cwd: root,
          capture: true,
        }),
    },
    {
      input: ".github/actions/setup/check/tools/action.yaml",
      update: updateMise,
    },
    { input: "home/applications/helium/config.toml", update: updateBrowser },
    {
      input: chatgptPackagePath,
      update: () =>
        Effect.gen(function* () {
          yield* run(["nix", "run", ".#update-chatgpt", "--", "--version=skip"], {
            cwd: join(root, chatgptDirectory),
            capture: true,
          });
          yield* run(["deadnix", "--fail", chatgptPackagePath], {
            cwd: root,
            capture: true,
          });
        }),
    },
  ];
  for (const { input, update } of pinUpdates) {
    if (changed.has(input)) yield* update();
  }
});

const rootManifests = [
  "package.json",
  ...workspace.workspaces.packages.map((directory) => `${directory}/package.json`),
];
const dependencyPins = Schema.decodeUnknownEffect(
  Schema.Record(Schema.String, Schema.String),
);

const updateRootPins = Effect.fn(function* () {
  const rootPath = join(root, "package.json");
  const manifest = yield* readManifest(rootPath);
  const pins = yield* dependencyPins(manifest.devDependencies);
  const { fallow } = pins;
  if (!fallow) return yield* Effect.fail(new DotfilesError("Missing Fallow version"));

  if (pins["fallow-type-aware"] !== fallow)
    yield* writeJson(rootPath, {
      ...manifest,
      devDependencies: { ...pins, "fallow-type-aware": fallow },
    });

  const tilingPath = join(root, "tools/tiling/package.json");
  const tiling = yield* readManifest(tilingPath);
  const tilingPins = yield* dependencyPins(tiling.devDependencies);
  if (tilingPins.fallow !== fallow)
    yield* writeJson(tilingPath, {
      ...tiling,
      devDependencies: { ...tilingPins, fallow },
    });

  const fs = yield* FileSystem.FileSystem;
  const path = join(root, "biome.jsonc");
  const content = yield* fs.readFileString(path);
  const schema = /https:\/\/biomejs\.dev\/schemas\/[^/]+\/schema\.json/g;
  const [binding, duplicate] = content.matchAll(schema);
  if (!binding || duplicate)
    return yield* Effect.fail(
      new DotfilesError("Expected one Biome schema version binding"),
    );
  const version = pins["@biomejs/biome"];
  if (!version) return yield* Effect.fail(new DotfilesError("Missing Biome version"));
  yield* writeIfChanged(
    path,
    content.replace(schema, () => `https://biomejs.dev/schemas/${version}/schema.json`),
  );
});

const alignRecipeModules = Effect.fn(function* (changed: Set<string>) {
  const fs = yield* FileSystem.FileSystem;
  for (const path of changed) {
    if (!/^systems\/spectrum\/recipes\/.*\.yml$/.test(path)) continue;
    const absolute = join(root, path);
    const content = yield* fs.readFileString(absolute);
    // Keep the module API selection aligned with its pinned image major
    const updated = content.replace(
      /(type:\s+)([a-z-]+)@v\d+(\s+source:\s+ghcr\.io\/blue-build\/modules\/\2:v)(\d+)(@sha256:[a-f0-9]{64})/g,
      (_, prefix, module, source, major, digest) =>
        `${prefix}${module}@v${major}${source}${major}${digest}`,
    );
    yield* writeIfChanged(absolute, updated);
  }
});

const refreshStagedLock = <E, R>(
  directory: string,
  inputs: string[],
  output: string,
  prefix: string,
  command: (staging: string) => Effect.Effect<unknown, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const staging = yield* fs.makeTempDirectoryScoped({ prefix });
      for (const name of inputs)
        yield* fs.copyFile(join(root, directory, name), join(staging, name));
      yield* command(staging);
      yield* fs.copyFile(join(staging, output), join(root, directory, output));
    }),
  );

const updateFlakeLocks = Effect.fn(function* (changed: Set<string>) {
  if (changed.has("flake.nix") || changed.has("flake.lock")) {
    yield* run(["nix", "flake", "lock"], { cwd: root, capture: true });
    yield* updateOmpDependencies();
  }
  if (
    changed.has(`${chatgptDirectory}/flake.nix`) ||
    changed.has(`${chatgptDirectory}/flake.lock`)
  ) {
    // Recompute the managed lock in an isolated flake directory
    yield* refreshStagedLock(
      chatgptDirectory,
      ["flake.nix", "flake.lock"],
      "flake.lock",
      "chatgpt-lock-",
      (staging) => run(["nix", "flake", "update"], { cwd: staging, capture: true }),
    );
  }
});

const updateYaziPackages = Effect.fn(function* (changed: Set<string>) {
  const directory = "home/files/.config/yazi";
  if (!changed.has(`${directory}/package.toml`)) return;
  // Recompute plugin hashes in an isolated config, never in the user's Yazi
  yield* refreshStagedLock(
    directory,
    ["package.toml"],
    "package.toml",
    "yazi-packages-",
    (staging) =>
      run(["ya", "pkg", "install"], {
        cwd: staging,
        env: { YAZI_CONFIG_HOME: staging },
        capture: true,
      }),
  );
});

const updateBunLocks = Effect.fn(function* (changed: Set<string>) {
  const runtime = "home/files/.local/lib";
  if (["package.json", "bun.lock"].some((name) => changed.has(join(runtime, name)))) {
    // Refresh the deployed lock outside workspace discovery
    yield* refreshStagedLock(
      runtime,
      ["package.json", "bun.lock"],
      "bun.lock",
      "dotfiles-runtime-lock-",
      (staging) =>
        run(["bun", "install", "--ignore-scripts", "--lockfile-only"], {
          cwd: staging,
          capture: true,
        }),
    );
  }
  // Workspace manifests refresh the root lockfile, not a nested lockfile
  if (["bun.lock", ...rootManifests].some((path) => changed.has(path))) {
    yield* run(["bun", "install", "--ignore-scripts", "--lockfile-only"], {
      cwd: root,
      capture: true,
    });
    yield* run(["bash", "tools/bun/generate-nix.sh"], { cwd: root, capture: true });
  }

  const renovate = ".github/renovate";
  if (["package.json", "bun.lock"].some((name) => changed.has(join(renovate, name))))
    yield* run(["bun", "install", "--ignore-scripts", "--lockfile-only"], {
      cwd: join(root, renovate),
      capture: true,
    });
});

// Every dependency update refreshes generated hashes and lockfiles before commit
// Failed commands must never produce PRs or issues
runMain(
  Effect.gen(function* () {
    let changed = yield* changedPaths();
    yield* updatePins(changed);
    if (changed.has("package.json")) yield* updateRootPins();
    yield* updateReleaseAssets({
      rustdesk: changed.has(spectrumSoftwareRecipe),
      karabiner: changed.has("flake.nix"),
    });
    yield* alignRecipeModules(changed);
    yield* updateFlakeLocks(changed);
    yield* updateYaziPackages(changed);
    changed = yield* changedPaths();
    yield* updateBunLocks(changed);
    if (changed.has("package.json") || changed.has("bun.lock")) yield* updatePalette();
  }),
);
