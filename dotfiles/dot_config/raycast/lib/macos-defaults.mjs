import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const RAYCAST_DEFAULTS_DOMAIN = "com.raycast-x.macos";

/**
 * @typedef {object} MacOSDefaultValue
 * @property {boolean} exists
 * @property {string} key
 * @property {"bool" | "string"} restoreType
 * @property {boolean | string | null} value
 */

/**
 * @param {{ key: string, restoreType: "bool" | "string" }} rule
 * @returns {Promise<MacOSDefaultValue>}
 */
export async function readMacOSDefault({ key, restoreType }) {
  try {
    const { stdout } = await execFile("defaults", [
      "read",
      RAYCAST_DEFAULTS_DOMAIN,
      key,
    ]);
    const value = stdout.trimEnd();
    return {
      exists: true,
      key,
      restoreType,
      value: restoreType === "bool" ? value === "1" : value,
    };
  } catch {
    return {
      exists: false,
      key,
      restoreType,
      value: null,
    };
  }
}

/**
 * @param {{ key: string }} defaultValue
 * @returns {Promise<void>}
 */
export async function deleteMacOSDefault({ key }) {
  await execFile("defaults", ["delete", RAYCAST_DEFAULTS_DOMAIN, key]).catch(() => {});
}

/**
 * @param {MacOSDefaultValue} defaultValue
 * @returns {Promise<void>}
 */
export async function restoreMacOSDefault(defaultValue) {
  if (!defaultValue.exists) {
    await deleteMacOSDefault(defaultValue);
    return;
  }

  const valueArgs =
    defaultValue.restoreType === "bool"
      ? ["-bool", defaultValue.value ? "true" : "false"]
      : ["-string", String(defaultValue.value)];

  await execFile("defaults", [
    "write",
    RAYCAST_DEFAULTS_DOMAIN,
    defaultValue.key,
    ...valueArgs,
  ]);
}
