import { join } from "node:path";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { ensureDirectory, writeIfChanged } from "@dotfiles/core/files";
import { configHome } from "@dotfiles/core/paths";
import { Console, Effect, FileSystem } from "effect";
import { configureGPU } from "./discord.ts";

export const syncEquicordSettings = Effect.fn("syncEquicordSettings")(function* () {
  if (process.platform === "darwin") return;
  const fs = yield* FileSystem.FileSystem;
  const home = process.env.HJEM_HOME_DIR;
  const repository = process.env.HJEM_WORKING_TREE;
  if (!home || !repository)
    return yield* Effect.fail(
      new DotfilesError("HJEM_HOME_DIR and HJEM_WORKING_TREE are required"),
    );
  yield* configureGPU(join(yield* configHome(), "discord"));
  const nix = yield* Effect.sync(() => Bun.which("nix"));
  if (!nix) {
    yield* Console.log("Equicord settings install skipped: nix is not available");
    return;
  }
  const result = yield* run(
    [nix, "build", "--no-link", "--print-out-paths", "path:.#equicord-settings"],
    { cwd: repository, capture: true },
  );
  const outputs = result.stdout.trimEnd().split("\n");
  const path = outputs[0];
  if (outputs.length !== 1 || !path)
    return yield* Effect.fail(
      new DotfilesError(
        `Equicord settings install failed: expected one Nix output, got ${JSON.stringify(outputs)}`,
      ),
    );
  const settings = yield* ensureDirectory(join(home, ".config/Equicord/settings"));
  for (const name of ["settings.json", "quickCss.css"])
    yield* writeIfChanged(join(settings, name), yield* fs.readFile(join(path, name)));
});
