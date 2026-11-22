import { join, resolve } from "node:path";
import { DotfilesError } from "@dotfiles/core/errors";

const root = import.meta.dir;

const result = await Bun.build({
  entrypoints: [join(root, "src/cli.ts")],
  target: "bun",
  compile: {
    outfile: resolve(root, "dist/workstation"),
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
});
if (!result.success) throw new DotfilesError(result.logs.map(String).join("\n"));
