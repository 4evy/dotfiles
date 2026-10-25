import { mkdir, mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { download, run } from "./process.ts";

export async function validateGhostty() {
  const sources = v.parse(
    v.object({
      ghostty: v.object({ canonical: v.string(), revision: v.string() }),
    }),
    JSON.parse(await run(["nix", "eval", ".#patchStackSources", "--json"])),
  );
  const patches = await run(["nix", "eval", ".#lib.patchesSource", "--raw"]);
  // Renovate runs on x86_64 Linux, matching this pinned compiler input
  const compiler = v.parse(
    v.object({ storePath: v.pipe(v.string(), v.minLength(1)) }),
    JSON.parse(
      await run([
        "nix",
        "flake",
        "prefetch",
        "--json",
        "--inputs-from",
        ".",
        "source-ghostty-zig-x86-64-linux",
      ]),
    ),
  ).storePath;
  const repository = sources.ghostty.canonical.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/,
  )?.[1];
  if (!repository) throw new Error("Unsupported Ghostty source endpoint");
  await using workspace = await mkdtempDisposable(join(tmpdir(), "ghostty-update-"));
  const staging = workspace.path;
  const source = join(staging, "source");
  const zig = join(staging, "zig");
  const cache = join(staging, "zig-cache");
  await mkdir(source);
  await mkdir(zig);
  await mkdir(join(cache, "tmp"), { recursive: true });
  const archive = join(staging, "source.tar.gz");
  await Bun.write(
    archive,
    await download(
      `https://codeload.github.com/${repository}/tar.gz/${sources.ghostty.revision}`,
    ),
  );
  await run(["tar", "-xzf", archive, "--strip-components=1", "-C", source]);
  await run(["tar", "-xJf", compiler, "--strip-components=1", "-C", zig]);
  const series = join(patches, "stacks/ghostty/patches");
  const entries = (await Bun.file(join(series, "series")).text())
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith("#"));
  for (const entry of entries) await run(["git", "apply", join(series, entry)], source);
  await run([join(zig, "zig"), "build", "--help"], source, {
    ...process.env,
    ZIG_GLOBAL_CACHE_DIR: cache,
  });
}
