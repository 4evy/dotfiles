/**
 * @typedef {object} InternalExtensionRule
 * @property {string} id
 * @property {false | "preserve"} [enabled]
 * @property {Record<string, unknown>} [syncedMeta]
 * @property {Record<string, unknown>} [localMeta]
 * @property {string[]} [enabledFallbackCommandIds]
 *
 * @typedef {object} StatusFieldRule
 * @property {string} key
 * @property {string[]} path
 * @property {unknown} [defaultValue]
 *
 * @typedef {object} MacOSDefaultRule
 * @property {string} key
 * @property {"bool" | "string"} restoreType
 *
 * @typedef {object} AiDataStatusQuery
 * @property {string} key
 * @property {string[]} methodPath
 * @property {(records: unknown) => number} [count]
 */

export const BACKUP_VERSION = 1;

export const AI_FALLBACK_COMMAND_IDS = ["c:r:ai::-::openQuickAi"];

export const AI_MODEL_USER_DEFAULT_KEYS = [
  "AIChatWindowLastUsedModel",
  "AIChatWindowSelectedModel",
  "SelectedAIModel",
];

export const AI_FRECENCY_PREFIXES = ["c:r:ai:", "c:r:dictation:", "c:r:translator:"];

/** @type {InternalExtensionRule[]} */
export const INTERNAL_EXTENSION_RULES = [
  {
    id: "e:r:ai",
    syncedMeta: {
      aiChatAskQuestionsEnabled: false,
      aiMemoryEnabled: false,
      aiToolConfirmationAllowList: [],
    },
    localMeta: {
      aiChatInvalidCompletionRecoveryEnabled: false,
    },
    enabledFallbackCommandIds: [],
  },
  {
    id: "e:r:dictation",
    syncedMeta: {
      appContext: false,
      autoDetectStyle: false,
    },
  },
  {
    id: "e:r:translator",
  },
  {
    id: "e:r:mcp",
  },
  {
    id: "e:r:file-search",
    enabled: "preserve",
    localMeta: {
      semanticIndexingPaths: [],
      semanticIndexingUseFileSearchScope: false,
    },
  },
];

/** @type {StatusFieldRule[]} */
export const INTERNAL_EXTENSION_STATUS_FIELDS = [
  { key: "enabled", path: ["enabled"] },
  {
    key: "enabledFallbackCommandIds",
    path: ["enabledFallbackCommandIds"],
    defaultValue: [],
  },
  {
    key: "aiChatAskQuestionsEnabled",
    path: ["syncedMeta", "aiChatAskQuestionsEnabled"],
  },
  { key: "aiMemoryEnabled", path: ["syncedMeta", "aiMemoryEnabled"] },
  {
    key: "aiChatInvalidCompletionRecoveryEnabled",
    path: ["localMeta", "aiChatInvalidCompletionRecoveryEnabled"],
  },
  {
    key: "semanticIndexingPaths",
    path: ["localMeta", "semanticIndexingPaths"],
  },
  {
    key: "semanticIndexingUseFileSearchScope",
    path: ["localMeta", "semanticIndexingUseFileSearchScope"],
  },
];

/** @type {MacOSDefaultRule[]} */
export const MACOS_DEFAULT_RULES = [
  {
    key: "raycast_HasOpenedAIChat",
    restoreType: "bool",
  },
  {
    key: "NSWindow Frame ai-chat-window",
    restoreType: "string",
  },
];

export const MERGEABLE_BACKUP_COLLECTIONS = [
  "internalExtensions",
  "models",
  "userDefaults",
  "macOSDefaults",
];

/** @type {AiDataStatusQuery[]} */
export const AI_DATA_STATUS_QUERIES = [
  {
    key: "chatCount",
    methodPath: ["ai", "chatGetAllIds"],
  },
  {
    key: "quickAiChatCount",
    methodPath: ["ai", "chatGetAllInvalidationSnapshots"],
    count: (snapshots) =>
      (snapshots || []).filter((snapshot) => snapshot.source === "quick_ai").length,
  },
  {
    key: "commandCount",
    methodPath: ["ai", "commandGetAll"],
  },
  {
    key: "modeCount",
    methodPath: ["ai", "modeGetAll"],
  },
  {
    key: "transcriptionCount",
    methodPath: ["ai", "transcriptionGetAll"],
  },
  {
    key: "transcriptionStyleCount",
    methodPath: ["ai", "transcriptionStyleGetAll"],
  },
  {
    key: "mcpServerCount",
    methodPath: ["settings", "allMcpServers"],
  },
];
