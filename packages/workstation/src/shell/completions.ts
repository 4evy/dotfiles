import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { run, which } from "../../../../lib/typescript/commands.ts";
import { DotfilesError } from "../../../../lib/typescript/errors.ts";
import { ensureDirectory, writeIfChanged } from "../../../../lib/typescript/files.ts";

const commandsSchema = v.pipe(
  v.custom<Record<string, unknown>>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  ),
  v.record(
    v.pipe(v.string(), v.regex(/^[A-Za-z0-9._+-]+$/)),
    v.pipe(v.array(v.string()), v.minLength(1)),
  ),
);

function capture(command: string[], target: string, shell: string): void {
  const executable = which(command[0] ?? "");
  if (!executable) {
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing?.isFile() || existing?.isSymbolicLink()) rmSync(target);
    return;
  }
  const result = run([executable, ...command.slice(1)], {
    check: false,
    capture: true,
    env: { SHELL: `/bin/${shell}` },
  });
  if (result.code !== 0)
    console.log(`Failed to generate shell integration for ${command[0]}`);
  else writeIfChanged(target, result.stdout);
}

export function shellCompletions(): void {
  const home = process.env.HJEM_HOME_DIR;
  if (!home) throw new DotfilesError("HJEM_HOME_DIR is required");
  const cache = process.env.XDG_CACHE_HOME ?? join(home, ".cache");
  const data = process.env.XDG_DATA_HOME ?? join(home, ".local/share");
  const path = join(home, ".config/shell/completion-commands.json");
  const commands = v.parse(
    commandsSchema,
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {},
  );
  for (const shell of ["zsh", "bash"]) {
    const directory = ensureDirectory(
      shell === "zsh"
        ? join(cache, "zsh/completions")
        : join(data, "bash-completion/completions"),
    );
    for (const [name, command] of Object.entries(commands))
      capture(
        command.map((part) => part.replaceAll("{shell}", shell)),
        join(directory, `${shell === "zsh" ? "_" : ""}${name}`),
        shell,
      );
  }
}
