import { join } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { writeIfChanged } from "@dotfiles/core/files";
import { runMain } from "@dotfiles/core/runtime";
import bunProjects from "@dotfiles/repo/data/bun/projects";
import { Effect, FileSystem, Schema } from "effect";
import { updateBrowser, updateBunBootstrap, updateMise } from "./checksums.ts";
import { validateGhostty } from "./ghostty.ts";
import { updateOmpDependencies } from "./omp.ts";
import { updateRenovatePatch } from "./patch.ts";
import { root } from "./paths.ts";

const changedPaths = Effect.fn(function* () {
  const paths = yield* output(["git", "diff", "HEAD", "--name-only", "-z"], {
    cwd: root,
  });
  return new Set(paths.split("\0").filter(Boolean));
});

// Every dependency update refreshes generated hashes and lockfiles before commit
// Failed commands must never produce PRs or issues
runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let changed = yield* changedPaths();

    const pinUpdates = [
      { input: ".github/renovate/package.json", update: updateRenovatePatch },
      { input: "tools/setup/setup.sh", update: updateBunBootstrap },
      { input: ".github/actions/setup/check/tools/action.yaml", update: updateMise },
      { input: "home/applications/helium/config.toml", update: updateBrowser },
      {
        input: "home/files/.local/share/nix/chatgpt/package.nix",
        update: () =>
          Effect.gen(function* () {
            yield* run(["nix", "run", ".#update-chatgpt", "--", "--version=skip"], {
              cwd: join(root, "home/files/.local/share/nix/chatgpt"),
              capture: true,
            });
            yield* run(
              ["deadnix", "--fail", "home/files/.local/share/nix/chatgpt/package.nix"],
              { cwd: root, capture: true },
            );
          }),
      },
    ];
    for (const { input, update } of pinUpdates) {
      if (changed.has(input)) yield* update();
    }
    if (changed.has("package.json")) {
      const manifest = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            devDependencies: Schema.Record(Schema.String, Schema.String),
          }),
        ),
      )(yield* fs.readFileString(join(root, "package.json")));
      const path = join(root, "biome.jsonc");
      const content = yield* fs.readFileString(path);
      const schema = /https:\/\/biomejs\.dev\/schemas\/[^/]+\/schema\.json/g;
      if ([...content.matchAll(schema)].length !== 1)
        return yield* Effect.fail(
          new DotfilesError("Expected one Biome schema version binding"),
        );
      const version = manifest.devDependencies["@biomejs/biome"];
      if (!version)
        return yield* Effect.fail(new DotfilesError("Missing Biome version"));
      yield* writeIfChanged(
        path,
        content.replace(
          schema,
          () => `https://biomejs.dev/schemas/${version}/schema.json`,
        ),
      );
    }
    if (changed.has("flake.nix") || changed.has("flake.lock")) {
      yield* run(["nix", "flake", "lock"], { cwd: root, capture: true });
      yield* updateOmpDependencies();
      yield* validateGhostty();
    }

    const chatgpt = "home/files/.local/share/nix/chatgpt";
    if (changed.has(`${chatgpt}/flake.nix`) || changed.has(`${chatgpt}/flake.lock`)) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const staging = yield* fs.makeTempDirectoryScoped({
            prefix: "chatgpt-lock-",
          });
          // Recompute the managed lock in an isolated flake directory
          yield* fs.copyFile(
            join(root, chatgpt, "flake.nix"),
            join(staging, "flake.nix"),
          );
          yield* fs.copyFile(
            join(root, chatgpt, "flake.lock"),
            join(staging, "flake.lock"),
          );
          yield* run(["nix", "flake", "update"], { cwd: staging, capture: true });
          yield* fs.copyFile(
            join(staging, "flake.lock"),
            join(root, chatgpt, "flake.lock"),
          );
        }),
      );
    }
    const yazi = "home/files/.config/yazi/package.toml";
    if (changed.has(yazi)) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const staging = yield* fs.makeTempDirectoryScoped({
            prefix: "yazi-packages-",
          });
          // Recompute plugin hashes in an isolated config, never in the user's Yazi
          yield* fs.copyFile(join(root, yazi), join(staging, "package.toml"));
          yield* run(["ya", "pkg", "install"], {
            cwd: staging,
            env: { YAZI_CONFIG_HOME: staging },
            capture: true,
          });
          yield* fs.copyFile(join(staging, "package.toml"), join(root, yazi));
        }),
      );
    }
    changed = yield* changedPaths();
    const runtime = "home/files/.local/lib";
    if (["package.json", "bun.lock"].some((name) => changed.has(join(runtime, name)))) {
      // Refresh the deployed lock outside workspace discovery
      yield* Effect.scoped(
        Effect.gen(function* () {
          const staging = yield* fs.makeTempDirectoryScoped({
            prefix: "dotfiles-runtime-lock-",
          });
          for (const name of ["package.json", "bun.lock"])
            yield* fs.copyFile(join(root, runtime, name), join(staging, name));
          yield* run(["bun", "install", "--ignore-scripts", "--lockfile-only"], {
            cwd: staging,
            capture: true,
          });
          yield* fs.copyFile(
            join(staging, "bun.lock"),
            join(root, runtime, "bun.lock"),
          );
        }),
      );
    }
    // Workspace manifests refresh their owning lockfile, not a nested lockfile
    for (const { directory, inputs, nix } of [
      ...bunProjects.map(({ directory, manifests, nix }) => ({
        directory,
        inputs: [...manifests, join(directory, "bun.lock")],
        nix,
      })),
      {
        directory: ".github/renovate",
        inputs: [".github/renovate/package.json", ".github/renovate/bun.lock"],
        nix: false,
      },
    ]) {
      if (!inputs.some((input) => changed.has(input))) continue;
      yield* run(["bun", "install", "--ignore-scripts", "--lockfile-only"], {
        cwd: join(root, directory),
        capture: true,
      });
      if (!nix) continue;
      const outputPath = `${directory}/bun.nix`;
      yield* run(
        [
          "nix",
          "run",
          ".#bun2nix",
          "--",
          "--lock-file",
          `${directory}/bun.lock`,
          // Local dependencies resolve beside the generated bun.nix
          "--copy-prefix",
          "./",
          "--output-file",
          outputPath,
        ],
        { cwd: root, capture: true },
      );
      yield* run(["deadnix", "--edit", outputPath], { cwd: root, capture: true });
      yield* run(["nixfmt", outputPath], { cwd: root, capture: true });
    }
  }),
);
