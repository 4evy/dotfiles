import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { PATHS, RESTORE_TYPE } from "./config.mts";

const execFile = promisify(execFileCallback);

export type MacOSRestoreType = (typeof RESTORE_TYPE)[keyof typeof RESTORE_TYPE];

export type MacOSDefaultValue = {
  exists: boolean;
  key: string;
  restoreType: string;
  value: boolean | string | null;
};

const WRITE_ARGS = {
  [RESTORE_TYPE.BOOL]: (value: MacOSDefaultValue["value"]) => [
    "-bool",
    value ? "true" : "false",
  ],
  [RESTORE_TYPE.STRING]: (value: MacOSDefaultValue["value"]) => [
    "-string",
    String(value),
  ],
} as const satisfies Record<
  MacOSRestoreType,
  (value: MacOSDefaultValue["value"]) => string[]
>;

function isRestoreType(value: string): value is MacOSRestoreType {
  return Object.hasOwn(WRITE_ARGS, value);
}

export async function readMacOSDefault({
  key,
  restoreType,
}: Pick<MacOSDefaultValue, "key" | "restoreType">): Promise<MacOSDefaultValue> {
  try {
    const { stdout } = await execFile(PATHS.defaultsBin, [
      "read",
      PATHS.defaultsDomain,
      key,
    ]);
    const raw = stdout.trimEnd();
    return {
      exists: true,
      key,
      restoreType,
      value: restoreType === RESTORE_TYPE.BOOL ? raw === "1" : raw,
    };
  } catch {
    return { exists: false, key, restoreType, value: null };
  }
}

export async function deleteMacOSDefault({ key }: { key: string }): Promise<void> {
  await execFile(PATHS.defaultsBin, ["delete", PATHS.defaultsDomain, key]).catch(
    () => {},
  );
}

export async function restoreMacOSDefault(value: MacOSDefaultValue): Promise<void> {
  if (!value.exists) {
    await deleteMacOSDefault(value);
    return;
  }

  if (!isRestoreType(value.restoreType)) {
    throw new Error(`unknown macOS restoreType: ${value.restoreType}`);
  }

  await execFile(PATHS.defaultsBin, [
    "write",
    PATHS.defaultsDomain,
    value.key,
    ...WRITE_ARGS[value.restoreType](value.value),
  ]);
}
