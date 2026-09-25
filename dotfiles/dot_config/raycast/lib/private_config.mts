import process from "node:process";
import policyJson from "../data/disable-ai.json" with { type: "json" };
import pathsJson from "../data/paths.json" with { type: "json" };
import runtimeJson from "../data/runtime.json" with { type: "json" };
import summaryJson from "../data/summary.json" with { type: "json" };
import type { InternalExtensionSettings } from "./types.mts";

export const POLICY = policyJson satisfies {
  backupVersion: number;
  fallbackCommandIds: string[];
  frecencyPrefixes: string[];
  mergeableBackupCollections: string[];
  internalExtensions: ExtensionRule[];
  statusFields: StatusField[];
  macOSDefaults: { key: string; restoreType: string }[];
  aiDataQueries: CountQuery[];
};

export const PATHS = pathsJson satisfies {
  appSupport: string;
  appBundle: string;
  dataAddon: string;
  nodeRuntime: string;
  nodeGlob: string;
  keyCacheName: string;
  aiDisableBackupName: string;
  defaultsBin: string;
  defaultsDomain: string;
  profileUserDefaults: { currentUser: string; oauthToken: string };
  env: {
    appSupport: string;
    appBundle: string;
    dataAddon: string;
    keyFile: string;
    keyDumpFile: string;
    aiDisableBackup: string;
  };
};

export const RUNTIME = runtimeJson satisfies {
  checkedAgainst: { raycastVersion: string; commit: string; date: string };
  node: {
    bundled: string;
    minimum: string;
    moduleAbi: number;
    typescriptMode: string;
    amaro: string;
  };
  typescript: {
    compiler: string;
    runtime: string;
    erasableSyntaxOnly: boolean;
    unsupportedSyntax: string[];
    modules: { esm: string; cjs: string; requireHook: string };
  };
  addon: { package: string; version: string; constructor: string[] };
};

export const SUMMARY = summaryJson satisfies {
  generalSettings: string[];
  counts: CountQuery[];
};

export type Policy = typeof POLICY;
export type Paths = typeof PATHS;
export type Runtime = typeof RUNTIME;
export type Summary = typeof SUMMARY;
export type ExtensionRule = Pick<InternalExtensionSettings, "id"> &
  Partial<
    Pick<
      InternalExtensionSettings,
      "enabled" | "syncedMeta" | "localMeta" | "enabledFallbackCommandIds"
    >
  >;

export type StatusField = {
  key: string;
  path: string[];
  defaultValue?: unknown;
  count?: boolean;
};

export type CountQuery = {
  key: string;
  methodPath: string[];
  args?: unknown[];
  select?: string;
  filter?: { path: string[]; equals: unknown };
};

export const RESTORE_TYPE = {
  BOOL: "bool",
  STRING: "string",
} as const;

export const OP = {
  INTERNAL_EXTENSION: "internal-extension",
  MODEL: "model",
  USER_DEFAULT: "user-default",
  FRECENCY: "frecency",
  MACOS_DEFAULT: "macos-default",
} as const;

export const IO = {
  JSON_INDENT: 2,
  FILE_MODE: 0o600,
} as const;

export function envName(key: keyof Paths["env"]): string {
  return PATHS.env[key];
}

export function assertSupportedNode(version = process.versions.node): void {
  const minimum = RUNTIME.node.minimum;
  if (version.localeCompare(minimum, undefined, { numeric: true }) < 0) {
    throw new Error(
      `Raycast scripts need Node ${minimum}+ type stripping; running ${version}`,
    );
  }
}

export function runtimeReport(): {
  contract: Runtime;
  process: {
    node: string;
    typescript: string | number | boolean | undefined;
    amaro: string | null;
    modules: string | undefined;
  };
} {
  return {
    contract: RUNTIME,
    process: {
      node: process.versions.node,
      typescript: process.features.typescript,
      amaro: process.versions.amaro ?? null,
      modules: process.versions.modules,
    },
  };
}
