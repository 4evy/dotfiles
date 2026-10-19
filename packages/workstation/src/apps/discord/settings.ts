import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run, which } from "../../../../../lib/typescript/commands.ts";
import { DotfilesError } from "../../../../../lib/typescript/errors.ts";
import {
  ensureDirectory,
  isExecutable,
  writeIfChanged,
} from "../../../../../lib/typescript/files.ts";

export function syncEquicordSettings(): void {
  if (process.platform === "darwin") return;
  const home = process.env.HJEM_HOME_DIR;
  const repository = process.env.HJEM_WORKING_TREE;
  if (!home || !repository)
    throw new DotfilesError("HJEM_HOME_DIR and HJEM_WORKING_TREE are required");
  let command = join(home, ".local/bin/discord-equicord");
  if (!existsSync(command)) command = which("discord-equicord") ?? command;
  if (isExecutable(command)) run([command, "--configure-only"]);
  const nix = which("nix");
  if (!nix) {
    console.log("Equicord settings install skipped: nix is not available");
    return;
  }
  const result = run(
    [nix, "build", "--no-link", "--print-out-paths", "path:.#equicord-settings"],
    { cwd: repository, capture: true },
  );
  const outputs = result.stdout.trimEnd().split("\n");
  const path = outputs[0];
  if (outputs.length !== 1 || !path)
    throw new DotfilesError(
      `Equicord settings install failed: expected one Nix output, got ${JSON.stringify(outputs)}`,
    );
  const settings = ensureDirectory(join(home, ".config/Equicord/settings"));
  for (const name of ["settings.json", "quickCss.css"])
    writeIfChanged(join(settings, name), readFileSync(join(path, name)));
}
