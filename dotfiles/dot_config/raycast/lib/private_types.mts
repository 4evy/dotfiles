export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type InternalExtensionSettings = {
  id: string;
  enabled: boolean;
  enabledFallbackCommandIds?: string[];
  syncedMeta?: Record<string, JsonValue>;
  localMeta?: Record<string, JsonValue>;
  macosSyncedMeta?: Record<string, JsonValue>;
  windowsSyncedMeta?: Record<string, JsonValue>;
  updatedAt?: string;
  deprecatedMeta?: JsonValue | null;
};

export type CommandSettings = {
  id: string;
  extensionId: string;
  enabled: boolean;
  alias?: string | null;
  updatedAt?: string;
  deviceGenerations?: JsonValue;
  localMeta?: Record<string, JsonValue>;
  syncedMeta?: Record<string, JsonValue>;
  macosHotkey?: JsonValue;
};

export type AiModel = {
  id: string;
  name?: string;
  provider?: string;
  providerBrand?: string;
  providerName?: string;
  model?: string;
  disabledAt?: string | null;
  updatedAt?: string;
};

export type FrecencyRecord = {
  itemId: string;
  [key: string]: unknown;
};

export type GeneralSettings = {
  appearance?: string;
  windowMode?: string;
  windowPresentationMode?: string;
  windowActivationBehavior?: string;
  navigationBindings?: string;
  pageNavigationKeys?: string;
  rootSearchSensitivity?: string;
  uiZoom?: number;
  [key: string]: unknown;
};

export type RaycastInitReport = {
  overallSuccess?: boolean;
  databaseResults?: Array<{
    databaseType: string;
    isAccessible: boolean;
    isEncrypted: boolean;
    fileExists: boolean;
    createdFresh: boolean;
    backupAvailable: boolean;
  }>;
  [key: string]: unknown;
};

export type RaycastUserDefaultsRepository = {
  get: (key: string) => Promise<string | number | boolean | null>;
  set: (key: string, value: string | number | boolean) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

export type SettingsRepository = {
  addInternalExtensionSettings: (settings: Record<string, unknown>) => Promise<void>;
  deleteInternalExtensionSettings: (id: string) => Promise<void>;
  getInternalExtensionSettings: (
    id: string,
  ) => Promise<InternalExtensionSettings | null | undefined>;
  updateInternalExtensionSettings: (
    id: string,
    settings: Record<string, unknown>,
  ) => Promise<void>;
  allInternalExtensionsSettings: () => Promise<InternalExtensionSettings[]>;
  getCommandSettings: (id: string) => Promise<CommandSettings | null | undefined>;
  updateCommandSettings: (
    id: string,
    settings: Record<string, unknown>,
  ) => Promise<void>;
  addCommandSettings: (settings: Record<string, unknown>) => Promise<void>;
  allCommandSettings: () => Promise<CommandSettings[]>;
  allMcpServers: () => Promise<unknown[]>;
  getGeneralSettings: () => Promise<GeneralSettings>;
};

export type AiRepository = {
  modelGetAll: () => Promise<AiModel[]>;
  modelSetDisabledAt: (id: string, disabledAt: string | null) => Promise<void>;
  chatGetAllIds: () => Promise<unknown[]>;
  chatGetAllInvalidationSnapshots: () => Promise<unknown[]>;
  commandGetAll: () => Promise<unknown[]>;
  modeGetAll: () => Promise<unknown[]>;
  transcriptionGetAll: () => Promise<unknown[]>;
  transcriptionStyleGetAll: () => Promise<unknown[]>;
};

export type FrecencyRepository = {
  getAll: () => Promise<FrecencyRecord[]>;
  reset: (itemId: string) => Promise<void>;
  insertMany: (records: FrecencyRecord[]) => Promise<void>;
};

export type RaycastDatabaseClient = {
  initReport: RaycastInitReport;
  userDefaults: RaycastUserDefaultsRepository;
  settings: SettingsRepository;
  ai: AiRepository;
  frecency: FrecencyRepository;
  getDatabaseStatus: () => Promise<unknown>;
  shutdown?: () => Promise<void> | void;
  [key: string]: unknown;
};

export type RaycastNativeAddon = {
  DatabaseClient: new (
    appSupport: string,
    key: string,
    logger: () => void,
  ) => RaycastDatabaseClient;
  [key: string]: unknown;
};

export type RaycastDatabaseContext = AsyncDisposable & {
  db: RaycastDatabaseClient;
  appSupport: string;
  keyFile: string | undefined;
};
