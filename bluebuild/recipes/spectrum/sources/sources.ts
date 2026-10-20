#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as v from "valibot";

const ROOT = resolve(import.meta.dir, "../../../..");
const objectInput = v.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
const Lock = v.pipe(
  objectInput,
  v.object({
    root: v.string(),
    nodes: v.pipe(
      objectInput,
      v.record(
        v.string(),
        v.pipe(
          objectInput,
          v.object({
            inputs: v.optional(
              v.pipe(
                objectInput,
                v.record(v.string(), v.union([v.string(), v.array(v.string())])),
              ),
            ),
            locked: v.optional(v.pipe(objectInput, v.record(v.string(), v.unknown()))),
            original: v.optional(
              v.pipe(objectInput, v.object({ ref: v.optional(v.string()) })),
            ),
          }),
        ),
      ),
    ),
  }),
);
const StackSources = v.pipe(
  objectInput,
  v.record(
    v.string(),
    v.pipe(objectInput, v.object({ canonical: v.string(), revision: v.string() })),
  ),
);

function inputPin(
  lock: v.InferOutput<typeof Lock>,
  name: string,
): Record<string, unknown> {
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
  lock: v.InferOutput<typeof Lock>,
  stackSources: v.InferOutput<typeof StackSources>,
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

async function main(): Promise<void> {
  const nix = Bun.which("nix");
  if (!nix) throw new Error("nix is required to prepare Spectrum sources");
  const lock = v.parse(Lock, await Bun.file(join(ROOT, "flake.lock")).json());
  const evaluation = Bun.spawnSync(
    [nix, "eval", ".#patchStackSources", "--json", "--no-write-lock-file"],
    { cwd: ROOT, stdout: "pipe", stderr: "inherit" },
  );
  if (evaluation.exitCode !== 0)
    throw new Error(`nix eval exited with status ${evaluation.exitCode}`);
  const stackSources = v.parse(StackSources, JSON.parse(evaluation.stdout.toString()));
  const directory = join(ROOT, "bluebuild/recipes/spectrum/sources");
  await mkdir(directory, { recursive: true });
  const groups = {
    ghostty: ["ghostty", "ghostty-zig-x86-64-linux"],
    kanata: ["kanata-homebrew"],
  };
  for (const [group, names] of Object.entries(groups)) {
    const pins = Object.fromEntries(
      names.map((name) => [name, sourcePin(name, lock, stackSources)]),
    );
    await Bun.write(join(directory, `${group}.json`), stableJson({ pins }));
  }
  const patches = v.parse(
    v.pipe(
      objectInput,
      v.object({ owner: v.string(), repo: v.string(), rev: v.string() }),
    ),
    inputPin(lock, "patches"),
  );
  await Bun.write(
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
}

if (import.meta.main) await main();
