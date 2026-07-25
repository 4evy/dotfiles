import { dataAddonPath, loadRaycastDataAddon } from "./raycast-database.mjs";

/**
 * @typedef {import("./raycast-database.mjs").RaycastDatabaseClient} RaycastDatabaseClient
 *
 * @typedef {object} MethodResolution
 * @property {(...args: unknown[]) => unknown} method
 * @property {Record<string, unknown>} receiver
 *
 * @typedef {object} MethodSurface
 * @property {{ methods: string[] }} client
 * @property {Record<string, { methods: string[] }>} repositories
 *
 * @typedef {[string, number | { error: string }]} CountEntry
 */

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function parseStoredJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * @param {Function | undefined} value
 * @returns {string[]}
 */
function prototypeMethods(value) {
  return Object.getOwnPropertyNames(value?.prototype || {})
    .filter((name) => name !== "constructor")
    .sort();
}

/**
 * @returns {{ addon: string, exports: Record<string, { type: string, methods?: string[] }> }}
 */
export function addonSurface() {
  const addon = loadRaycastDataAddon();
  return {
    addon: dataAddonPath(),
    exports: Object.fromEntries(
      Object.keys(addon)
        .sort()
        .map((name) => {
          const value = addon[name];
          const type = typeof value;
          return [
            name,
            {
              type,
              methods: type === "function" ? prototypeMethods(value) : undefined,
            },
          ];
        }),
    ),
  };
}

/**
 * @param {Record<string, unknown>} value
 * @returns {string[]}
 */
function callableMethods(value) {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(value) || {})
    .filter((name) => name !== "constructor" && typeof value[name] === "function")
    .sort();
}

/**
 * @param {Record<string, unknown>} value
 * @returns {string[]}
 */
function repositoryGetters(value) {
  return Object.entries(
    Object.getOwnPropertyDescriptors(Object.getPrototypeOf(value) || {}),
  )
    .filter(([, descriptor]) => typeof descriptor.get === "function")
    .map(([name]) => name)
    .sort();
}

/**
 * @param {RaycastDatabaseClient} db
 * @returns {MethodSurface}
 */
export function databaseMethodSurface(db) {
  const clientMethods = callableMethods(db);
  const repositories = repositoryGetters(db)
    .map((name) => [name, db[name]])
    .filter(([, value]) => value && typeof value === "object")
    .map(([name, value]) => [
      name,
      {
        methods: callableMethods(value),
      },
    ]);

  return {
    client: {
      methods: clientMethods.filter((name) => typeof db[name] === "function"),
    },
    repositories: Object.fromEntries(repositories),
  };
}

/**
 * @param {RaycastDatabaseClient} db
 * @param {string} methodPath
 * @returns {MethodResolution}
 */
export function resolveDatabaseMethod(db, methodPath) {
  const segments = methodPath.split(".").filter(Boolean);
  if (segments.length === 0) throw new Error("method path is required");

  const methodName = segments.at(-1);
  const receiver = segments
    .slice(0, -1)
    .reduce((current, segment) => current?.[segment], db);
  const target = segments.length === 1 ? db : receiver;
  const method = target?.[methodName];

  if (typeof method !== "function") {
    throw new Error(`unknown database method: ${methodPath}`);
  }

  return {
    method,
    receiver: target,
  };
}

/**
 * @param {() => Promise<unknown>} method
 * @returns {Promise<number>}
 */
async function countFrom(method) {
  const value = await method();
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.length;
  if (value == null) return 0;
  return Object.keys(value).length;
}

/**
 * @param {string} label
 * @param {() => Promise<unknown>} method
 * @returns {Promise<CountEntry>}
 */
async function optionalCount(label, method) {
  try {
    return [label, await countFrom(method)];
  } catch (error) {
    return [label, { error: error.message }];
  }
}

/**
 * @param {RaycastDatabaseClient} db
 * @returns {Promise<Record<string, unknown>>}
 */
export async function databaseSummary(db) {
  const [
    databaseStatus,
    generalSettings,
    internalExtensions,
    nodeExtensions,
    nodeCommands,
    nodeTools,
    commandSettings,
    mcpServers,
    quicklinks,
    snippets,
    notes,
    clipboard,
    frecency,
    userActivity,
    aiChats,
    aiModels,
    aiCommands,
    aiModes,
    aiTranscriptions,
    aiTranscriptionStyles,
  ] = await Promise.all([
    db.getDatabaseStatus(),
    db.settings.getGeneralSettings(),
    db.settings.allInternalExtensionsSettings(),
    optionalCount("nodeExtensions", () => db.nodeExtensions.allExtensions()),
    optionalCount("nodeCommands", () => db.nodeExtensions.allCommands()),
    optionalCount("nodeTools", () => db.nodeExtensions.allTools()),
    optionalCount("commandSettings", () => db.settings.allCommandSettings()),
    optionalCount("mcpServers", () => db.settings.allMcpServers()),
    optionalCount("quicklinks", () => db.quicklinks.count()),
    optionalCount("snippets", () => db.snippets.count()),
    optionalCount("notes", () => db.notes.count()),
    optionalCount("clipboard", async () => (await db.clipboard.all({})).entries),
    optionalCount("frecency", () => db.frecency.getAll()),
    optionalCount("userActivity", () => db.userActivity.getAllActivities()),
    optionalCount("aiChats", () => db.ai.chatGetAllIds()),
    optionalCount("aiModels", () => db.ai.modelGetAll()),
    optionalCount("aiCommands", () => db.ai.commandGetAll()),
    optionalCount("aiModes", () => db.ai.modeGetAll()),
    optionalCount("aiTranscriptions", () => db.ai.transcriptionGetAll()),
    optionalCount("aiTranscriptionStyles", () => db.ai.transcriptionStyleGetAll()),
  ]);

  return {
    databases: databaseStatus,
    generalSettings: {
      appearance: generalSettings.appearance,
      windowMode: generalSettings.windowMode,
      windowPresentationMode: generalSettings.windowPresentationMode,
      windowActivationBehavior: generalSettings.windowActivationBehavior,
      navigationBindings: generalSettings.navigationBindings,
      pageNavigationKeys: generalSettings.pageNavigationKeys,
      rootSearchSensitivity: generalSettings.rootSearchSensitivity,
      uiZoom: generalSettings.uiZoom,
    },
    internalExtensions: {
      total: internalExtensions.length,
      enabled: internalExtensions.filter((extension) => extension.enabled).length,
      disabled: internalExtensions
        .filter((extension) => !extension.enabled)
        .map((extension) => extension.id)
        .sort(),
    },
    counts: Object.fromEntries([
      nodeExtensions,
      nodeCommands,
      nodeTools,
      commandSettings,
      mcpServers,
      quicklinks,
      snippets,
      notes,
      clipboard,
      frecency,
      userActivity,
      aiChats,
      aiModels,
      aiCommands,
      aiModes,
      aiTranscriptions,
      aiTranscriptionStyles,
    ]),
  };
}

/**
 * @param {RaycastDatabaseClient} db
 * @returns {Promise<{ currentUser: unknown, oauthToken: unknown }>}
 */
export async function profileDefaults(db) {
  const currentUser = parseStoredJson(await db.userDefaults.get("CurrentUser"));
  const oauthToken = parseStoredJson(await db.userDefaults.get("OAuthTokenResponse"));

  return {
    currentUser,
    oauthToken,
  };
}

/**
 * @param {RaycastDatabaseClient} db
 * @param {string} key
 * @returns {Promise<unknown>}
 */
export async function userDefaultValue(db, key) {
  return parseStoredJson(await db.userDefaults.get(key));
}
