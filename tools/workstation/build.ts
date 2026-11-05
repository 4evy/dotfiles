import { join, resolve } from "node:path";
import { DotfilesError } from "@dotfiles/core/errors";

const root = import.meta.dir;

export async function buildWorkstation(destination: string) {
  const result = await Bun.build({
    entrypoints: [join(root, "src/cli.ts")],
    target: "bun",
    compile: {
      outfile: destination,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  if (!result.success)
    throw new DotfilesError(result.logs.map(String).join("\n"));
}

if (import.meta.main) await buildWorkstation(resolve(root, "dist/workstation"));
