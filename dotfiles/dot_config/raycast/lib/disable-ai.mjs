import { clone, countRecords, pathExists, readJson, writeJson } from "./common.mjs";
import {
  AI_DATA_STATUS_QUERIES,
  AI_FALLBACK_COMMAND_IDS,
  AI_FRECENCY_PREFIXES,
  AI_MODEL_USER_DEFAULT_KEYS,
  BACKUP_VERSION,
  INTERNAL_EXTENSION_RULES,
  INTERNAL_EXTENSION_STATUS_FIELDS,
  MACOS_DEFAULT_RULES,
  MERGEABLE_BACKUP_COLLECTIONS,
} from "./disable-ai-policy.mjs";
import {
  deleteMacOSDefault,
  readMacOSDefault,
  restoreMacOSDefault,
} from "./macos-defaults.mjs";

/**
 * @typedef {import("./raycast-database.mjs").RaycastDatabaseClient} RaycastDatabaseClient
 * @typedef {import("./disable-ai-policy.mjs").InternalExtensionRule} InternalExtensionRule
 * @typedef {import("./disable-ai-policy.mjs").StatusFieldRule} StatusFieldRule
 *
 * @typedef {Record<string, unknown>} JsonObject
 * @typedef {{ type: string, apply: () => Promise<unknown> | unknown } & JsonObject} Operation
 * @typedef {JsonObject & { version: number }} DisableAiSnapshot
 */

/**
 * @param {unknown} itemId
 * @returns {boolean}
 */
export function isRaycastAiItemId(itemId) {
  return (
    typeof itemId === "string" &&
    AI_FRECENCY_PREFIXES.some((prefix) => itemId.startsWith(prefix))
  );
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => Promise<[string, unknown]>} mapper
 * @returns {Promise<Record<string, unknown>>}
 */
async function objectFromAsync(items, mapper) {
  return Object.fromEntries(await Promise.all(items.map(mapper)));
}

/**
 * @param {unknown} value
 * @param {string[]} path
 * @returns {unknown}
 */
function valueAtPath(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

/**
 * @param {Record<string, unknown>} item
 * @param {StatusFieldRule} field
 * @returns {unknown}
 */
function statusField(item, field) {
  const value = valueAtPath(item, field.path);
  if (value !== undefined) return value;
  return clone(field.defaultValue);
}

/**
 * @param {string} type
 * @param {JsonObject} fields
 * @param {Operation["apply"]} apply
 * @returns {Operation}
 */
function operation(type, fields, apply) {
  return {
    type,
    ...fields,
    apply,
  };
}

/**
 * @param {JsonObject} target
 * @param {JsonObject} source
 * @returns {boolean}
 */
function mergeMissingProperties(target, source) {
  let changed = false;
  for (const [key, value] of Object.entries(source)) {
    if (target[key] !== undefined) continue;
    target[key] = value;
    changed = true;
  }
  return changed;
}

/**
 * @param {Record<string, unknown>} source
 * @param {string[]} path
 * @returns {Promise<unknown>}
 */
function methodAtPath(source, path) {
  const methodName = path.at(-1);
  const receiver = path
    .slice(0, -1)
    .reduce((current, segment) => current?.[segment], source);
  const method = receiver?.[methodName];
  if (typeof method !== "function") {
    throw new Error(`missing Raycast database method: ${path.join(".")}`);
  }
  return method.call(receiver);
}

/**
 * @param {RaycastDatabaseClient} db
 * @returns {Promise<DisableAiSnapshot>}
 */
export async function buildSnapshot(db) {
  const internalExtensions = await objectFromAsync(
    INTERNAL_EXTENSION_RULES,
    async ({ id }) => [id, clone(await db.settings.getInternalExtensionSettings(id))],
  );

  const models = Object.fromEntries(
    (await db.ai.modelGetAll()).map((model) => [
      model.id,
      { disabledAt: model.disabledAt ?? null },
    ]),
  );

  const userDefaults = await objectFromAsync(
    AI_MODEL_USER_DEFAULT_KEYS,
    async (key) => [key, await db.userDefaults.get(key)],
  );

  const frecencyRecords = (await db.frecency.getAll()).filter((record) =>
    isRaycastAiItemId(record.itemId),
  );
  const macOSDefaults = await objectFromAsync(MACOS_DEFAULT_RULES, async (rule) => [
    rule.key,
    await readMacOSDefault(rule),
  ]);

  return {
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    internalExtensions,
    models,
    userDefaults,
    frecencyRecords,
    macOSDefaults,
  };
}

/**
 * @param {Record<string, unknown>} previous
 * @param {InternalExtensionRule} rule
 * @returns {Record<string, unknown>}
 */
function disabledInternalExtension(previous, rule) {
  if (!previous?.id) throw new Error("internal extension settings are missing an id");

  const next = {
    ...clone(previous),
    enabled: rule.enabled === "preserve" ? previous.enabled : false,
    syncedMeta: {
      ...(previous.syncedMeta ?? {}),
      ...(rule.syncedMeta ?? {}),
    },
    localMeta: {
      ...(previous.localMeta ?? {}),
      ...(rule.localMeta ?? {}),
    },
  };

  next.enabledFallbackCommandIds =
    rule.enabledFallbackCommandIds === undefined
      ? clone(previous.enabledFallbackCommandIds ?? [])
      : clone(rule.enabledFallbackCommandIds);

  return next;
}

/**
 * @param {Operation[]} operations
 * @param {boolean} dryRun
 * @returns {Promise<JsonObject[]>}
 */
async function runOperations(operations, dryRun) {
  for (const operation of operations) {
    if (!dryRun) await operation.apply();
  }

  return operations.map(({ apply, ...summary }) => summary);
}

/**
 * @param {RaycastDatabaseClient} db
 * @param {DisableAiSnapshot} before
 * @param {boolean} dryRun
 * @returns {Promise<JsonObject[]>}
 */
export async function applyDisabled(db, before, dryRun) {
  const now = new Date().toISOString();
  const internalExtensionOperations = INTERNAL_EXTENSION_RULES.map((rule) => {
    const next = disabledInternalExtension(before.internalExtensions[rule.id], rule);
    return operation(
      "internal-extension",
      {
        id: rule.id,
        enabled: next.enabled,
        clearedFallbackCommands: rule.id === "e:r:ai" ? AI_FALLBACK_COMMAND_IDS : [],
      },
      () => db.settings.updateInternalExtensionSettings(rule.id, next),
    );
  });

  const modelOperations = Object.keys(before.models).map((id) =>
    operation("model", { id, disabledAt: now }, () =>
      db.ai.modelSetDisabledAt(id, now),
    ),
  );

  const userDefaultOperations = Object.keys(before.userDefaults).map((key) =>
    operation("user-default", { key, value: null }, () => db.userDefaults.delete(key)),
  );

  const frecencyOperations = (before.frecencyRecords || []).map((record) =>
    operation("frecency", { itemId: record.itemId, action: "reset" }, () =>
      db.frecency.reset(record.itemId),
    ),
  );
  const macOSDefaultOperations = Object.keys(before.macOSDefaults || {}).map((key) =>
    operation("macos-default", { key, action: "delete" }, () =>
      deleteMacOSDefault({ key }),
    ),
  );

  return runOperations(
    [
      ...internalExtensionOperations,
      ...modelOperations,
      ...userDefaultOperations,
      ...frecencyOperations,
      ...macOSDefaultOperations,
    ],
    dryRun,
  );
}

/**
 * @param {DisableAiSnapshot} backup
 * @returns {void}
 */
export function assertSupportedBackup(backup) {
  if (backup.version !== BACKUP_VERSION) {
    throw new Error(`unsupported backup version: ${backup.version}`);
  }
}

/**
 * @param {string} file
 * @param {DisableAiSnapshot} before
 * @param {boolean} dryRun
 * @returns {Promise<boolean>}
 */
export async function ensureBackup(file, before, dryRun) {
  if (dryRun) return false;

  if (!(await pathExists(file))) {
    await writeJson(file, before);
    return true;
  }

  const existing = await readJson(file);
  assertSupportedBackup(existing);

  let changed = mergeMissingProperties(existing, before);
  for (const key of MERGEABLE_BACKUP_COLLECTIONS) {
    if (!before[key]) continue;
    existing[key] ??= {};
    changed = mergeMissingProperties(existing[key], before[key]) || changed;
  }

  if (changed) await writeJson(file, existing);
  return changed;
}

/**
 * @param {RaycastDatabaseClient} db
 * @param {string} appSupport
 * @param {(appSupport: string) => string} backupPath
 * @param {boolean} dryRun
 * @returns {Promise<JsonObject[]>}
 */
export async function restore(db, appSupport, backupPath, dryRun) {
  const file = backupPath(appSupport);
  if (!(await pathExists(file))) throw new Error(`backup not found: ${file}`);

  const backup = await readJson(file);
  assertSupportedBackup(backup);

  const internalExtensionOperations = Object.entries(
    backup.internalExtensions || {},
  ).map(([id, previous]) =>
    operation("internal-extension", { id, enabled: previous.enabled }, () =>
      db.settings.updateInternalExtensionSettings(id, previous),
    ),
  );

  const modelOperations = Object.entries(backup.models || {}).map(([id, previous]) => {
    const disabledAt = previous.disabledAt ?? null;
    return operation("model", { id, disabledAt }, () =>
      db.ai.modelSetDisabledAt(id, disabledAt),
    );
  });

  const userDefaultOperations = Object.entries(backup.userDefaults || {}).map(
    ([key, value]) =>
      operation("user-default", { key, value }, () =>
        value == null ? db.userDefaults.delete(key) : db.userDefaults.set(key, value),
      ),
  );

  const frecencyOperations = backup.frecencyRecords?.length
    ? [
        operation("frecency", { restoredRecords: backup.frecencyRecords.length }, () =>
          db.frecency.insertMany(backup.frecencyRecords),
        ),
      ]
    : [];
  const macOSDefaultOperations = Object.entries(backup.macOSDefaults || {}).map(
    ([key, defaultValue]) =>
      operation("macos-default", { key, exists: defaultValue.exists }, () =>
        restoreMacOSDefault(defaultValue),
      ),
  );

  return runOperations(
    [
      ...internalExtensionOperations,
      ...modelOperations,
      ...userDefaultOperations,
      ...frecencyOperations,
      ...macOSDefaultOperations,
    ],
    dryRun,
  );
}

/**
 * @param {RaycastDatabaseClient} db
 * @returns {Promise<Record<string, unknown>>}
 */
async function internalExtensionStatus(db) {
  return objectFromAsync(INTERNAL_EXTENSION_RULES, async ({ id }) => {
    const item = await db.settings.getInternalExtensionSettings(id);
    return [
      id,
      Object.fromEntries(
        INTERNAL_EXTENSION_STATUS_FIELDS.map((field) => [
          field.key,
          statusField(item, field),
        ]),
      ),
    ];
  });
}

/**
 * @param {RaycastDatabaseClient} db
 * @param {{ key: string, methodPath: string[], count?: (records: unknown) => number }} query
 * @returns {Promise<[string, unknown]>}
 */
async function queryAiDataStatus(db, query) {
  const records = await methodAtPath(db, query.methodPath);
  return [query.key, query.count?.(records) ?? countRecords(records)];
}

/**
 * @returns {Promise<Record<string, unknown>>}
 */
async function macOSDefaultsStatus() {
  return objectFromAsync(MACOS_DEFAULT_RULES, async (rule) => [
    rule.key,
    await readMacOSDefault(rule),
  ]);
}

/**
 * @param {RaycastDatabaseClient} db
 * @returns {Promise<Record<string, unknown>>}
 */
async function aiDataStatus(db) {
  return objectFromAsync(AI_DATA_STATUS_QUERIES, (query) =>
    queryAiDataStatus(db, query),
  );
}

/**
 * @param {RaycastDatabaseClient} db
 * @returns {Promise<Record<string, unknown>>}
 */
export async function status(db) {
  const [internalExtensions, models, frecencyRecords, macOSDefaults, aiData] =
    await Promise.all([
      internalExtensionStatus(db),
      db.ai.modelGetAll(),
      db.frecency
        .getAll()
        .then((records) =>
          records.filter((record) => isRaycastAiItemId(record.itemId)),
        ),
      macOSDefaultsStatus(),
      aiDataStatus(db),
    ]);

  return {
    internalExtensions,
    modelCount: models.length,
    disabledModelCount: models.filter((model) => model.disabledAt != null).length,
    aiFrecencyCount: frecencyRecords.length,
    aiData,
    macOSDefaults,
  };
}
