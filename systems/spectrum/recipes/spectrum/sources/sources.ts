#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { output, requireCommands } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Schema } from "effect";

const ROOT = resolve(import.meta.dir, "../../../../..");
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
      locked: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      original: Schema.optionalKey(
        Schema.Struct({ ref: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
});
const StackSources = Schema.Record(
  Schema.String,
  Schema.Struct({ canonical: Schema.String, revision: Schema.String }),
);

function inputPin(lock: typeof Lock.Type, name: string): Record<string, unknown> {
  const rootInputs = lock.nodes[lock.root]?.inputs;
  const dependencies = rootInputs?.dependencies;
  const inputs =
    typeof dependencies === "string" ? lock.nodes[dependencies]?.inputs : rootInputs;
  const nodeName = inputs?.[name];
  if (typeof nodeName !== "string") throw new Error(`Unresolved source input: ${name}`);
  const node = lock.nodes[nodeName];
  if (!node?.locked) throw new Error(`Unlocked source input: ${name}`);
  return { ...node.locked, ref: node.original?.ref ?? null };
}

function sourcePin(
  name: string,
  lock: typeof Lock.Type,
  stackSources: typeof StackSources.Type,
): Record<string, unknown> {
  const source = stackSources[name === "kanata-homebrew" ? "kanata" : name];
  if (!source) return inputPin(lock, `source-${name}`);
  const parts = source.canonical.split("/");
  const repo = parts.at(-1)?.replace(/\.git$/, "");
  const owner = parts.at(-2);
  if (!owner || !repo)
    throw new Error(`Invalid source repository: ${source.canonical}`);
  return { owner, repo, rev: source.revision, type: "github" };
}

function stableJson(value: unknown): string {
  // Stable key ordering keeps projected locks reviewable across runtimes
  return `${JSON.stringify(
    value,
    (_key, entry: unknown) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        );
      }
      return entry;
    },
    2,
  )}\n`;
}

// Pure lock projection rejects unresolved inputs before writing their inventories
const project = <A>(f: () => A) =>
  Effect.try({ try: f, catch: (cause) => new DotfilesError(String(cause)) });

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* requireCommands("nix");
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
        stackSources: StackSources,
        config: Schema.Struct({ nixCustomConf: Schema.String, dconf: Schema.String }),
      }),
    ),
  )(evaluation);
  const { stackSources } = buildData;
  const directory = join(ROOT, "systems/spectrum/recipes/spectrum/sources");
  yield* fs.makeDirectory(directory, { recursive: true });
  const rootfs = join(directory, "system");
  yield* fs.makeDirectory(join(rootfs, "etc/nix"), { recursive: true });
  yield* fs.makeDirectory(join(rootfs, "etc/dconf/db/local.d"), { recursive: true });
  yield* fs.writeFileString(
    join(rootfs, "etc/nix/nix.custom.conf"),
    buildData.config.nixCustomConf,
  );
  yield* fs.writeFileString(
    join(rootfs, "etc/dconf/db/local.d/60-spectrum-workstation"),
    buildData.config.dconf,
  );
  const groups = {
    ghostty: ["ghostty", "ghostty-zig-x86-64-linux"],
    kanata: ["kanata-homebrew"],
  };
  for (const [group, names] of Object.entries(groups)) {
    const pins = yield* project(() =>
      Object.fromEntries(
        names.map((name) => [name, sourcePin(name, lock, stackSources)]),
      ),
    );
    yield* fs.writeFileString(join(directory, `${group}.json`), stableJson({ pins }));
  }
  const patches = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ owner: Schema.String, repo: Schema.String, rev: Schema.String }),
  )(yield* project(() => inputPin(lock, "patches")));
  yield* fs.writeFileString(
    join(directory, "patches.json"),
    `${JSON.stringify(
      {
        repository: `https://github.com/${patches.owner}/${patches.repo}.git`,
        revision: patches.rev,
      },
      null,
      2,
    )}\n`,
  );
});

if (import.meta.main) runMain(main);
