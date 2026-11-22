#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { output, requireCommands } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { writeJson } from "@dotfiles/core/files";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Schema } from "effect";

const ROOT = resolve(import.meta.dir, "../../../../..");
const Base = Schema.Struct({
  "base-image": Schema.String.check(
    Schema.isPattern(/^[a-z0-9.-]+(:[0-9]+)?(\/[a-z0-9._-]+)+$/),
  ),
  "image-version": Schema.String.check(
    Schema.isPattern(/^\w[\w.-]{0,127}@sha256:[a-f0-9]{64}$/),
  ),
});
const Lock = Schema.Struct({
  root: Schema.String,
  nodes: Schema.Record(
    Schema.String,
    Schema.Struct({
      inputs: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Union([Schema.String, Schema.Array(Schema.String)]),
        ),
      ),
      locked: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});
const GitHubPin = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  rev: Schema.String,
});

function patchesPin(lock: typeof Lock.Type): unknown {
  const rootInputs = lock.nodes[lock.root]?.inputs;
  const dependencies = rootInputs?.dependencies;
  const inputs =
    typeof dependencies === "string" ? lock.nodes[dependencies]?.inputs : rootInputs;
  const nodeName = inputs?.patches;
  return typeof nodeName === "string" ? lock.nodes[nodeName]?.locked : undefined;
}

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* requireCommands("nix");
  const recipe = yield* fs.readFileString(
    join(ROOT, "systems/spectrum/recipes/spectrum.yml"),
  );
  const base = yield* Schema.decodeUnknownEffect(Base)(
    yield* Effect.try({
      try: () => Bun.YAML.parse(recipe),
      catch: (cause) => new DotfilesError("Invalid Spectrum recipe", { cause }),
    }),
  );
  const lock = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Lock))(
    yield* fs.readFileString(join(ROOT, "flake.lock")),
  );
  const evaluation = yield* output(
    ["nix", "eval", ".#lib.spectrumBuildData", "--json", "--no-write-lock-file"],
    { cwd: ROOT, stderr: "inherit" },
  );
  const buildData = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        stackSources: Schema.Struct({
          kanata: Schema.Struct({
            canonical: Schema.String,
            revision: Schema.String,
          }),
        }),
        config: Schema.Struct({
          nixCustomConf: Schema.String,
          dconf: Schema.String,
        }),
      }),
    ),
  )(evaluation);
  const { kanata } = buildData.stackSources;
  const [, owner, repo] =
    kanata.canonical.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/) ??
    [];
  if (!owner || !repo)
    return yield* Effect.fail(
      new DotfilesError(`Invalid Kanata source repository: ${kanata.canonical}`),
    );
  const patches = yield* Schema.decodeUnknownEffect(GitHubPin)(patchesPin(lock));
  const directory = join(ROOT, "systems/spectrum/recipes/spectrum/sources");
  const rootfs = join(directory, "system");
  yield* fs.makeDirectory(join(rootfs, "etc/nix"), { recursive: true });
  yield* fs.makeDirectory(join(rootfs, "etc/dconf/db/local.d"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    join(rootfs, "etc/nix/nix.custom.conf"),
    buildData.config.nixCustomConf,
  );
  yield* fs.writeFileString(
    join(rootfs, "etc/dconf/db/local.d/60-spectrum-workstation"),
    buildData.config.dconf,
  );
  yield* writeJson(join(directory, "kanata.json"), {
    pins: {
      "kanata-homebrew": { owner, repo, rev: kanata.revision, type: "github" },
    },
  });
  yield* writeJson(join(directory, "patches.json"), {
    repository: `https://github.com/${patches.owner}/${patches.repo}.git`,
    revision: patches.rev,
  });
  // CI verifies this exact reference before letting BlueBuild resolve it
  console.log(`${base["base-image"]}:${base["image-version"]}`);
});

if (import.meta.main) runMain(main);
