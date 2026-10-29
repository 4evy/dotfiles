import { join } from "node:path";
import * as v from "valibot";
import { writeJson } from "../../lib/typescript/files.ts";
import { root, run } from "./process.ts";

const dependencyMap = v.record(v.string(), v.string());
const manifestSchema = v.looseObject({
  dependencies: v.optional(dependencyMap),
  devDependencies: v.optional(dependencyMap),
});

// Workspace OMP versions follow the locked AI input, not independent npm updates
// Run `bun run sync:omp` after manually updating that input
export async function updateOmpDependencies(): Promise<void> {
  const { storePath } = v.parse(
    v.object({ storePath: v.string() }),
    JSON.parse(
      await run(["nix", "flake", "prefetch", "--json", "--inputs-from", root, "ai"]),
    ),
  );
  const { dependencies } = v.parse(
    v.object({ dependencies: dependencyMap }),
    await Bun.file(join(storePath, "apps/omp/runtime/upstream/package.json")).json(),
  );

  const path = join(root, "home/package.json");
  const manifest: unknown = await Bun.file(path).json();
  v.assert(manifestSchema, manifest);
  for (const section of [manifest.dependencies, manifest.devDependencies]) {
    if (!section) continue;
    for (const name of Object.keys(section)) {
      if (!name.startsWith("@oh-my-pi/")) continue;
      const version = dependencies[name];
      if (!version) throw new Error(`The AI runtime does not declare ${name}`);
      section[name] = version;
    }
  }
  writeJson(path, manifest);
}

if (import.meta.main) {
  await updateOmpDependencies();
  await run(["bun", "install", "--ignore-scripts", "--lockfile-only"]);
}
