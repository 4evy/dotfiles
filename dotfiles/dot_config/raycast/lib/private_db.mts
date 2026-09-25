import { glob, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import { envName, PATHS } from "./config.mts";
import type {
  RaycastDatabaseClient,
  RaycastDatabaseContext,
  RaycastNativeAddon,
} from "./types.mts";
import { expandHome, pathExists } from "./util.mts";

const require = createRequire(import.meta.url);

export type { RaycastDatabaseClient, RaycastDatabaseContext, RaycastNativeAddon };

function envOr(key: keyof typeof PATHS.env, fallback: string): string {
  return expandHome(process.env[envName(key)] || fallback);
}

export function dataAddonPath(): string {
  return envOr(
    "dataAddon",
    path.join(envOr("appBundle", PATHS.appBundle), PATHS.dataAddon),
  );
}

export function backupPath(appSupport: string): string {
  return envOr("aiDisableBackup", path.join(appSupport, PATHS.aiDisableBackupName));
}

export function loadRaycastDataAddon(): RaycastNativeAddon {
  return require(dataAddonPath()) as RaycastNativeAddon;
}

export async function latestRaycastNodeBin(
  appSupport: string,
): Promise<string | undefined> {
  const runtimeDir = path.join(appSupport, PATHS.nodeRuntime);
  const matches = await Array.fromAsync(
    glob(PATHS.nodeGlob, { cwd: runtimeDir }),
  ).catch(() => [] as string[]);

  return matches
    .map((relative) => path.join(runtimeDir, path.dirname(relative)))
    .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .at(0);
}

export async function findKeyFile(appSupport: string): Promise<string | undefined> {
  const configured = expandHome(process.env[envName("keyFile")]);
  if (configured) return configured;

  const nodeBin = await latestRaycastNodeBin(appSupport);
  if (nodeBin) {
    const cached = path.join(nodeBin, PATHS.keyCacheName);
    if (await pathExists(cached)) return cached;
  }

  return undefined;
}

export async function readKey(keyFile: string | undefined): Promise<string> {
  if (!keyFile) throw new Error("Raycast database key file was not found");

  const bytes = await readFile(keyFile);
  if (bytes.includes(0)) {
    throw new Error(
      `${keyFile} contains raw key bytes; use the runtime ${PATHS.keyCacheName} dumped by keydump.cts`,
    );
  }

  return bytes.toString("utf8").trim();
}

export function openDatabaseWithKey({
  appSupport,
  key,
  nativeAddon,
}: {
  appSupport: string;
  key: string;
  nativeAddon: string;
}): RaycastDatabaseClient {
  const addon = require(nativeAddon) as RaycastNativeAddon;
  const db = new addon.DatabaseClient(appSupport, key, () => {});
  if (!db.initReport?.overallSuccess) {
    throw new Error(
      `failed to open Raycast database: ${JSON.stringify(db.initReport)}`,
    );
  }
  return db;
}

export async function loadDatabase(): Promise<RaycastDatabaseContext> {
  const appSupport = envOr("appSupport", PATHS.appSupport);
  const keyFile = await findKeyFile(appSupport);
  const db = openDatabaseWithKey({
    appSupport,
    key: await readKey(keyFile),
    nativeAddon: dataAddonPath(),
  });

  return {
    db,
    appSupport,
    keyFile,
    async [Symbol.asyncDispose]() {
      await db.shutdown?.();
    },
  };
}

export async function withDatabase<T>(
  action: (context: RaycastDatabaseContext) => Promise<T>,
): Promise<T> {
  const context = await loadDatabase();
  try {
    return await action(context);
  } finally {
    await context[Symbol.asyncDispose]();
  }
}
