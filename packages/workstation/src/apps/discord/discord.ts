import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { run } from "../../../../../lib/typescript/commands.ts";
import { DotfilesError } from "../../../../../lib/typescript/errors.ts";
import { isExecutable, writeJson } from "../../../../../lib/typescript/files.ts";
import { configHome } from "../../../../../lib/typescript/paths.ts";
import { shellWords } from "../../../../../lib/typescript/shell/shell.ts";

const objectInput = v.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
const coercibleBoolean = v.pipe(
  v.unknown(),
  v.parseBoolean({
    truthy: [true, 1, "1", "on", "true", "yes", "t", "y"],
    falsy: [false, 0, "0", "off", "false", "no", "f", "n"],
  }),
);
const switches = v.pipe(
  objectInput,
  v.looseObject({
    force_high_performance_gpu: v.optional(coercibleBoolean, true),
  }),
);
const settingsSchema = v.pipe(
  objectInput,
  v.looseObject({
    enableHardwareAcceleration: v.optional(coercibleBoolean, true),
    DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING: v.optional(
      coercibleBoolean,
      true,
    ),
    chromiumSwitches: v.optional(
      v.pipe(
        v.unknown(),
        v.transform((value) =>
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {},
        ),
        switches,
      ),
      () => ({}),
    ),
  }),
);

export function configureGPU(directory: string): void {
  const path = join(directory, "settings.json");
  const parsed = v.safeParse(
    settingsSchema,
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {},
  );
  if (!parsed.success)
    throw new DotfilesError(`Invalid Discord settings JSON: ${path}`);
  const settings = parsed.output;
  settings.enableHardwareAcceleration = true;
  settings.DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING = true;
  settings.chromiumSwitches.force_high_performance_gpu = true;
  writeJson(path, settings, 0o600);
}

export function discord(args: string[]): number {
  if (process.platform === "darwin")
    throw new DotfilesError("Discord on macOS is managed by Nixcord");
  configureGPU(join(configHome(), "discord"));
  if (args.includes("--configure-only")) return 0;
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
  const executable = [
    "/run/current-system/sw/bin/Discord",
    join(state, "hjem/standalone/current-profile/bin/Discord"),
    join(homedir(), ".nix-profile/bin/Discord"),
  ].find(isExecutable);
  if (!executable)
    throw new DotfilesError("Nix-managed Discord was not found, run just nix");
  const path = join(configHome(), "discord-flags.conf");
  const flags = existsSync(path) ? shellWords(readFileSync(path, "utf8")) : [];
  return run([executable, ...flags, ...args], { check: false }).code;
}
