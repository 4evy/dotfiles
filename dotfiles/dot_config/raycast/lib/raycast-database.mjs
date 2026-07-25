import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import { expandHome, pathExists } from "./common.mjs";

const require = createRequire(import.meta.url);

/**
 * @typedef {Record<string, any>} RaycastInitReport
 *
 * @typedef {object} RaycastUserDefaultsRepository
 * @property {(key: string) => Promise<string | null>} get
 * @property {(key: string, value: string) => Promise<void>} set
 * @property {(key: string) => Promise<void>} delete
 *
 * @typedef {Record<string, (...args: any[]) => any>} RaycastRepository
 *
 * @typedef {Record<string, any> & {
 *   initReport: RaycastInitReport & { overallSuccess?: boolean },
 *   userDefaults: RaycastUserDefaultsRepository,
 *   ai: RaycastRepository,
 *   clipboard: RaycastRepository,
 *   frecency: RaycastRepository,
 *   nodeExtensions: RaycastRepository,
 *   quicklinks: RaycastRepository,
 *   settings: RaycastRepository,
 *   snippets: RaycastRepository,
 *   notes: RaycastRepository,
 *   userActivity: RaycastRepository,
 *   getDatabaseStatus: () => Promise<any>,
 *   shutdown?: () => Promise<void> | void,
 * }} RaycastDatabaseClient
 *
 * @typedef {Record<string, any> & {
 *   DatabaseClient: new (appSupport: string, key: string, logger: () => void) => RaycastDatabaseClient,
 * }} RaycastNativeAddon
 *
 * @typedef {object} RaycastDatabaseContext
 * @property {RaycastDatabaseClient} db
 * @property {string} appSupport
 * @property {string | undefined} keyFile
 */

export const DEFAULT_APP_SUPPORT = "~/Library/Application Support/com.raycast-x.macos";
export const DEFAULT_APP_BUNDLE = "/Applications/Raycast Beta.app";
export const DEFAULT_DATA_ADDON =
  "Contents/Resources/macos-app_RaycastDesktopApp.bundle/Contents/Resources/backend/data.darwin-arm64.node";

/**
 * @param {string} appSupport
 * @returns {Promise<string | undefined>}
 */
export async function latestRaycastNodeBin(appSupport) {
  const runtimeDir = path.join(appSupport, "node/runtime");
  if (!(await pathExists(runtimeDir))) return undefined;

  const entries = await readdir(runtimeDir, { withFileTypes: true });
  const bins = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("node-v")) continue;

    const bin = path.join(runtimeDir, entry.name, "bin");
    if (await pathExists(path.join(bin, "node"))) bins.push(bin);
  }

  return bins.toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
}

/**
 * @param {string} appSupport
 * @returns {Promise<string | undefined>}
 */
export async function findKeyFile(appSupport) {
  const configured = expandHome(process.env.RAYCAST_KEY_FILE);
  if (configured) return configured;

  const nodeBin = await latestRaycastNodeBin(appSupport);
  if (nodeBin) {
    const cached = path.join(nodeBin, ".raycast-key-cache");
    if (await pathExists(cached)) return cached;
  }

  const lastKey = path.join(appSupport, "last_key");
  return (await pathExists(lastKey)) ? lastKey : undefined;
}

/**
 * @param {string | undefined} keyFile
 * @returns {Promise<string>}
 */
export async function readKey(keyFile) {
  if (!keyFile) throw new Error("Raycast database key file was not found");

  const bytes = await readFile(keyFile);
  if (bytes.includes(0)) {
    throw new Error(
      `${keyFile} contains raw key bytes; use the runtime .raycast-key-cache dumped by keydump.cjs`,
    );
  }

  return bytes.toString("utf8").trim();
}

/**
 * @param {{ appSupport: string, key: string, nativeAddon: string }} options
 * @returns {RaycastDatabaseClient}
 */
export function openDatabaseWithKey({ appSupport, key, nativeAddon }) {
  /** @type {RaycastNativeAddon} */
  const raycastData = require(nativeAddon);
  const db = new raycastData.DatabaseClient(appSupport, key, () => {});

  if (!db.initReport?.overallSuccess) {
    throw new Error(
      `failed to open Raycast database: ${JSON.stringify(db.initReport)}`,
    );
  }

  return db;
}

/**
 * Opens Raycast's native database client using the configured or dumped key file.
 *
 * @returns {Promise<RaycastDatabaseContext>}
 */
export async function loadDatabase() {
  const appSupport = expandHome(process.env.RAYCAST_APP_SUPPORT || DEFAULT_APP_SUPPORT);
  const appBundle = expandHome(process.env.RAYCAST_APP_BUNDLE || DEFAULT_APP_BUNDLE);
  const addon = expandHome(
    process.env.RAYCAST_DATA_ADDON || path.join(appBundle, DEFAULT_DATA_ADDON),
  );

  const keyFile = await findKeyFile(appSupport);
  const key = await readKey(keyFile);
  const db = openDatabaseWithKey({
    appSupport,
    key,
    nativeAddon: addon,
  });

  return { db, appSupport, keyFile };
}

/**
 * @returns {string}
 */
export function dataAddonPath() {
  const appBundle = expandHome(process.env.RAYCAST_APP_BUNDLE || DEFAULT_APP_BUNDLE);
  return expandHome(
    process.env.RAYCAST_DATA_ADDON || path.join(appBundle, DEFAULT_DATA_ADDON),
  );
}

/**
 * @returns {RaycastNativeAddon}
 */
export function loadRaycastDataAddon() {
  return require(dataAddonPath());
}

/**
 * @param {string} appSupport
 * @returns {string}
 */
export function backupPath(appSupport) {
  return expandHome(
    process.env.RAYCAST_AI_DISABLE_BACKUP ||
      path.join(appSupport, "raycast-ai-disable-backup.json"),
  );
}
