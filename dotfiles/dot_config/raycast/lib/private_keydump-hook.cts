const fs = require("node:fs") as typeof import("node:fs");
const Module = require("node:module") as typeof import("node:module");

const PATHS = require("../data/paths.json") as typeof import("../data/paths.json");
const RUNTIME =
  require("../data/runtime.json") as typeof import("../data/runtime.json");

const PATCHED = Symbol.for("dotfiles.raycast.keydumpHookPatched");
const KEY_FIELDS = ["encryptionKey", "databaseKey", "key"] as const;
const KEY_ARG = Math.max(RUNTIME.addon.constructor.indexOf("encryptionKey"), 1);

type DatabaseClientConstructor = new (...args: unknown[]) => object;
type RaycastDataAddon = { DatabaseClient: DatabaseClientConstructor };
type PatchedModule = typeof Module.prototype & { [PATCHED]?: true };

function isRaycastDataAddon(value: unknown): value is RaycastDataAddon {
  return (
    !!value &&
    typeof value === "object" &&
    "DatabaseClient" in value &&
    typeof value.DatabaseClient === "function"
  );
}

function encryptionKeyValue(value: unknown): string | Buffer | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Buffer.isBuffer(value) && value.length > 0) return value;
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const field of KEY_FIELDS) {
    const nested = encryptionKeyValue(record[field]);
    if (nested) return nested;
  }
  return undefined;
}

function encryptionKeyFromConstructorArgs(
  args: unknown[],
): string | Buffer | undefined {
  return encryptionKeyValue(args[KEY_ARG]) ?? encryptionKeyValue(args[0]);
}

function installDatabaseKeyDump(keyFile = process.env[PATHS.env.keyDumpFile]): void {
  if (!keyFile) throw new Error(`${PATHS.env.keyDumpFile} is required`);
  const destination = keyFile;
  const proto = Module.prototype as PatchedModule;
  if (proto[PATCHED]) return;

  const originalRequire = Module.prototype.require;
  Module.prototype.require = function requireWithKeyDump(id: string) {
    const result = originalRequire.call(this, id);
    if (id.includes("data.darwin-arm64") && isRaycastDataAddon(result)) {
      const OriginalDatabaseClient = result.DatabaseClient;
      result.DatabaseClient = class DatabaseClientWithKeyDump extends (
        OriginalDatabaseClient
      ) {
        constructor(...ctorArgs: unknown[]) {
          const key = encryptionKeyFromConstructorArgs(ctorArgs);
          if (key) {
            const descriptor = fs.openSync(destination, "w", 0o600);
            try {
              fs.fchmodSync(descriptor, 0o600);
              fs.writeFileSync(descriptor, key);
            } finally {
              fs.closeSync(descriptor);
            }
          }
          super(...ctorArgs);
        }
      };
    }
    return result;
  };

  proto[PATCHED] = true;
}

module.exports = {
  encryptionKeyFromConstructorArgs,
  installDatabaseKeyDump,
};
