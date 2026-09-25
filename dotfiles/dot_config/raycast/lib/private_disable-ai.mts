import { isDeepStrictEqual } from "node:util";

import { type ExtensionRule, OP, POLICY, type StatusField } from "./config.mts";
import type { RaycastDatabaseClient } from "./db.mts";
import {
  deleteMacOSDefault,
  type MacOSDefaultValue,
  readMacOSDefault,
  restoreMacOSDefault,
} from "./macos.mts";
import type { AiModel, FrecencyRecord } from "./types.mts";
import {
  asRecord,
  count,
  getPath,
  isRecord,
  mapEntries,
  pathExists,
  queryCount,
  readJson,
  writeJson,
} from "./util.mts";

export type JsonObject = Record<string, unknown>;
export type Operation = {
  type: string;
  apply: () => Promise<unknown> | unknown;
  [key: string]: unknown;
};

export type Snapshot = {
  version: number;
  createdAt: string;
  internalExtensions: Record<string, JsonObject>;
  models: Record<string, Pick<AiModel, "disabledAt">>;
  frecencyRecords: FrecencyRecord[];
  macOSDefaults: Record<string, MacOSDefaultValue>;
};

type CollectionKey = Exclude<keyof Snapshot, "version" | "createdAt">;

type Collection<K extends CollectionKey> = {
  key: K;
  snapshot: (db: RaycastDatabaseClient) => Promise<Snapshot[K]>;
  disable: (input: {
    db: RaycastDatabaseClient;
    value: Snapshot[K];
    now: string;
  }) => Operation[];
  restore: (input: { db: RaycastDatabaseClient; value: Snapshot[K] }) => Operation[];
};

function collection<K extends CollectionKey>(spec: Collection<K>) {
  return {
    key: spec.key,
    snapshot: spec.snapshot,
    disable: (db: RaycastDatabaseClient, before: Snapshot, now: string) =>
      spec.disable({ db, value: before[spec.key], now }),
    restore: (db: RaycastDatabaseClient, backup: Snapshot) =>
      spec.restore({ db, value: backup[spec.key] }),
  };
}

function op(type: string, fields: JsonObject, apply: Operation["apply"]): Operation {
  return { type, ...fields, apply };
}

export function isRaycastAiItemId(itemId: unknown): itemId is string {
  return (
    typeof itemId === "string" &&
    POLICY.frecencyPrefixes.some((prefix) => itemId.startsWith(prefix))
  );
}

function disabledInternalExtension(
  previous: Record<string, unknown>,
  { id: _id, ...patch }: ExtensionRule,
): Record<string, unknown> {
  if (!previous.id) throw new Error("internal extension settings are missing an id");

  // Raycast 2.5.1's backend Kzt enables content indexing whenever contentSearch
  // is true and contentSearchEngine is not "native". Empty scopes alone do not
  // disable it; the file-search policy selects the native engine explicitly.
  return structuredClone({
    ...previous,
    ...patch,
    syncedMeta: { ...asRecord(previous.syncedMeta), ...patch.syncedMeta },
    localMeta: { ...asRecord(previous.localMeta), ...patch.localMeta },
    enabledFallbackCommandIds:
      patch.enabledFallbackCommandIds ?? previous.enabledFallbackCommandIds ?? [],
  });
}

async function restoreInternalExtension(
  db: RaycastDatabaseClient,
  id: string,
  previous: JsonObject,
): Promise<void> {
  const current = await db.settings.getInternalExtensionSettings(id);
  // The native update method merges metadata, including null values. Replacing
  // the row is necessary to remove preferences absent from the original backup.
  if (current) await db.settings.deleteInternalExtensionSettings(id);
  if (!previous.id) return;
  try {
    await db.settings.addInternalExtensionSettings(previous);
  } catch (error) {
    if (current) {
      try {
        await db.settings.addInternalExtensionSettings(current);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `failed to restore ${id} and recover its previous settings; retain the backup`,
        );
      }
    }
    throw error;
  }
}

const COLLECTIONS = [
  collection({
    key: "internalExtensions",
    snapshot: (db) =>
      mapEntries(POLICY.internalExtensions, async ({ id }) => [
        id,
        structuredClone((await db.settings.getInternalExtensionSettings(id)) ?? {}),
      ]),
    disable: ({ db, value }) =>
      POLICY.internalExtensions.flatMap((rule) => {
        const previous = value[rule.id];
        // Missing rows inherit the built-in enabled default. Persist the policy
        // for fresh installations too, while recording absence for restore.
        const next = disabledInternalExtension(
          previous?.id ? previous : { id: rule.id, enabled: true },
          rule,
        );
        return [
          op(
            OP.INTERNAL_EXTENSION,
            {
              id: rule.id,
              enabled: next.enabled,
              clearedFallbackCommands:
                "enabledFallbackCommandIds" in rule ? POLICY.fallbackCommandIds : [],
            },
            () =>
              previous?.id
                ? db.settings.updateInternalExtensionSettings(rule.id, next)
                : db.settings.addInternalExtensionSettings(next),
          ),
        ];
      }),
    restore: ({ db, value }) =>
      Object.entries(value).map(([id, previous]) =>
        op(OP.INTERNAL_EXTENSION, { id, enabled: previous.enabled }, () =>
          restoreInternalExtension(db, id, previous),
        ),
      ),
  }),
  collection({
    key: "models",
    snapshot: async (db) =>
      Object.fromEntries(
        (await db.ai.modelGetAll()).map((model) => [
          model.id,
          { disabledAt: model.disabledAt ?? null },
        ]),
      ),
    disable: ({ db, value, now }) =>
      Object.keys(value)
        .filter((id) => value[id]?.disabledAt == null)
        .map((id) =>
          op(OP.MODEL, { id, disabledAt: now }, () =>
            db.ai.modelSetDisabledAt(id, now),
          ),
        ),
    restore: ({ db, value }) =>
      Object.entries(value).map(([id, previous]) => {
        const disabledAt = previous.disabledAt ?? null;
        return op(OP.MODEL, { id, disabledAt }, () =>
          db.ai.modelSetDisabledAt(id, disabledAt),
        );
      }),
  }),
  collection({
    key: "frecencyRecords",
    snapshot: async (db) =>
      (await db.frecency.getAll()).filter((record) => isRaycastAiItemId(record.itemId)),
    disable: ({ db, value }) =>
      value.map((record) =>
        op(OP.FRECENCY, { itemId: record.itemId, action: "reset" }, () =>
          db.frecency.reset(record.itemId),
        ),
      ),
    restore: ({ db, value }) =>
      value.length
        ? [
            op(OP.FRECENCY, { restoredRecords: value.length }, () =>
              db.frecency.insertMany(value),
            ),
          ]
        : [],
  }),
  collection({
    key: "macOSDefaults",
    snapshot: () =>
      mapEntries(POLICY.macOSDefaults, async (rule) => [
        rule.key,
        await readMacOSDefault(rule),
      ]),
    disable: ({ value }) =>
      Object.keys(value).map((key) =>
        op(OP.MACOS_DEFAULT, { key, action: "delete" }, () =>
          deleteMacOSDefault({ key }),
        ),
      ),
    restore: ({ value }) =>
      Object.entries(value).map(([key, defaultValue]) =>
        op(OP.MACOS_DEFAULT, { key, exists: defaultValue.exists }, () =>
          restoreMacOSDefault(defaultValue),
        ),
      ),
  }),
] as const;

async function runOperations(
  operations: Operation[],
  dryRun: boolean,
): Promise<JsonObject[]> {
  if (!dryRun) {
    for (const current of operations) await current.apply();
  }
  return operations.map(({ apply: _apply, ...summary }) => summary);
}

export async function buildSnapshot(db: RaycastDatabaseClient): Promise<Snapshot> {
  return {
    version: POLICY.backupVersion,
    createdAt: new Date().toISOString(),
    ...Object.fromEntries(
      await Promise.all(
        COLLECTIONS.map(async (entry) => [entry.key, await entry.snapshot(db)]),
      ),
    ),
  } as Snapshot;
}

export async function applyDisabled(
  db: RaycastDatabaseClient,
  before: Snapshot,
  dryRun: boolean,
): Promise<JsonObject[]> {
  const now = new Date().toISOString();
  return runOperations(
    COLLECTIONS.flatMap((entry) => entry.disable(db, before, now)),
    dryRun,
  );
}

function asSnapshot(value: unknown): Snapshot {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error("invalid Raycast AI disable backup");
  }
  if (value.version !== POLICY.backupVersion) {
    throw new Error(`unsupported backup version: ${value.version}`);
  }
  for (const key of POLICY.mergeableBackupCollections) {
    if (!isRecord(value[key])) {
      throw new Error(`invalid backup collection: ${key}`);
    }
  }
  for (const [id, settings] of Object.entries(
    asRecord(value.internalExtensions) ?? {},
  )) {
    if (
      !isRecord(settings) ||
      (Object.keys(settings).length > 0 &&
        (settings.id !== id || typeof settings.enabled !== "boolean"))
    ) {
      throw new Error(`invalid backup extension: ${id}`);
    }
    for (const key of [
      "syncedMeta",
      "localMeta",
      "macosSyncedMeta",
      "windowsSyncedMeta",
    ]) {
      if (settings[key] != null && !isRecord(settings[key])) {
        throw new Error(`invalid backup metadata: ${id}.${key}`);
      }
    }
  }
  if (
    !Array.isArray(value.frecencyRecords) ||
    value.frecencyRecords.some(
      (record) => !isRecord(record) || typeof record.itemId !== "string",
    )
  ) {
    throw new Error("invalid backup collection: frecencyRecords");
  }
  return value as Snapshot;
}

export async function ensureBackup(
  file: string,
  before: Snapshot,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;

  if (!(await pathExists(file))) {
    await writeJson(file, before);
    return true;
  }

  const existing = asSnapshot(await readJson(file));
  const savedIds = new Set(existing.frecencyRecords.map((record) => record.itemId));
  // Existing values win: repeated disables must retain the original settings.
  const merged: Snapshot = {
    ...existing,
    ...Object.fromEntries(
      POLICY.mergeableBackupCollections.map((key) => [
        key,
        { ...asRecord(getPath(before, [key])), ...asRecord(getPath(existing, [key])) },
      ]),
    ),
    frecencyRecords: [
      ...existing.frecencyRecords,
      ...before.frecencyRecords.filter((record) => !savedIds.has(record.itemId)),
    ],
  };

  if (isDeepStrictEqual(existing, merged)) return false;
  await writeJson(file, merged);
  return true;
}

export async function restore(
  db: RaycastDatabaseClient,
  appSupport: string,
  backupPathFor: (appSupport: string) => string,
  dryRun: boolean,
): Promise<JsonObject[]> {
  const file = backupPathFor(appSupport);
  if (!(await pathExists(file))) throw new Error(`backup not found: ${file}`);

  const backup = asSnapshot(await readJson(file));
  return runOperations(
    COLLECTIONS.flatMap((entry) => entry.restore(db, backup)),
    dryRun,
  );
}

function statusFieldValue(item: unknown, field: StatusField): unknown {
  const value = getPath(item, field.path);
  return field.count ? count(value) : (value ?? structuredClone(field.defaultValue));
}

export async function status(
  db: RaycastDatabaseClient,
): Promise<Record<string, unknown>> {
  const [internalExtensions, models, frecencyRecords, macOSDefaults, aiData] =
    await Promise.all([
      mapEntries(POLICY.internalExtensions, async ({ id }) => {
        const item = asRecord(await db.settings.getInternalExtensionSettings(id));
        if (!item?.id) return [id, { present: false }];
        return [
          id,
          {
            present: true,
            ...Object.fromEntries(
              POLICY.statusFields.map((field) => [
                field.key,
                statusFieldValue(item, field),
              ]),
            ),
          },
        ];
      }),
      db.ai.modelGetAll(),
      db.frecency
        .getAll()
        .then((records) =>
          records.filter((record) => isRaycastAiItemId(record.itemId)),
        ),
      mapEntries(POLICY.macOSDefaults, async (rule) => [
        rule.key,
        await readMacOSDefault(rule),
      ]),
      mapEntries(POLICY.aiDataQueries, (query) => queryCount(db, query)),
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
