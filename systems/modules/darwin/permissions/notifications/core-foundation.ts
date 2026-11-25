import {
  type Pointer as BunPointer,
  dlopen,
  type Library,
  ptr,
  read,
  type Symbols,
} from "bun:ffi";
import { isAbsolute } from "node:path";

export type Pointer = BunPointer | bigint;

export interface PreferenceDomain {
  suite: string;
  container: string;
}

export interface ContainerPreference {
  copy(): Pointer | null;
  set(value: Pointer): void;
  synchronize(): void;
}

export interface CoreFoundation {
  cf: {
    CFEqual(left: Pointer, right: Pointer): number;
    CFArrayGetCount(value: Pointer): bigint;
    CFArrayGetValueAtIndex(value: Pointer, index: bigint): Pointer | null;
    CFArrayCreateMutableCopy(
      allocator: Pointer | null,
      capacity: bigint,
      value: Pointer,
    ): Pointer | null;
    CFArraySetValueAtIndex(value: Pointer, index: bigint, entry: Pointer): void;
    CFDictionaryGetValue(value: Pointer, key: Pointer): Pointer | null;
    CFDictionaryCreateMutableCopy(
      allocator: Pointer | null,
      capacity: bigint,
      value: Pointer,
    ): Pointer | null;
    CFDictionarySetValue(value: Pointer, key: Pointer, entry: Pointer): void;
  };
  types: { array: bigint; dictionary: bigint; string: bigint; number: bigint };
  preference(key: string, domain: PreferenceDomain): ContainerPreference;
  own(value: Pointer | null, label: string): Pointer;
  size(value: bigint, label: string): number;
  createString(value: string): Pointer;
  requireType(value: Pointer | null, type: bigint, label: string): Pointer;
  readString(value: Pointer | null, label: string): string;
  readNumber(value: Pointer | null, label: string): bigint;
  createNumber(value: bigint): Pointer;
  readPropertyList(path: string, source: string): Pointer;
}

const framework = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const rtldLazy = 1;
const fileUrlIsDirectory = 0;
const readStreamToEnd = 0n;
const propertyListImmutable = 0n;
const propertyListBinaryFormat = 200n;

const systemSymbols = {
  dlopen: { args: ["cstring", "i32"], returns: "ptr" },
  dlsym: { args: ["ptr", "cstring"], returns: "ptr" },
  dlclose: { args: ["ptr"], returns: "i32" },
} as const satisfies Symbols;
type SystemLibrary = Library<typeof systemSymbols>;

function openCoreFoundation(): CoreFoundation & { close(): void } {
  if (process.platform !== "darwin") {
    throw new Error("Notification preferences require macOS");
  }
  // Open the platform libraries only after --help and non-Darwin requests return
  const library = dlopen(framework, {
    CFRelease: { args: ["ptr"], returns: "void" },
    CFGetTypeID: { args: ["ptr"], returns: "u64" },
    CFEqual: { args: ["ptr", "ptr"], returns: "u8" },
    CFStringGetTypeID: { args: [], returns: "u64" },
    CFStringCreateWithCString: {
      args: ["ptr", "cstring", "u32"],
      returns: "ptr",
    },
    CFStringGetLength: { args: ["ptr"], returns: "i64" },
    CFStringGetMaximumSizeForEncoding: { args: ["i64", "u32"], returns: "i64" },
    CFStringGetCString: { args: ["ptr", "ptr", "i64", "u32"], returns: "u8" },
    CFArrayGetTypeID: { args: [], returns: "u64" },
    CFArrayGetCount: { args: ["ptr"], returns: "i64" },
    CFArrayGetValueAtIndex: { args: ["ptr", "i64"], returns: "ptr" },
    CFArrayCreateMutableCopy: { args: ["ptr", "i64", "ptr"], returns: "ptr" },
    CFArraySetValueAtIndex: { args: ["ptr", "i64", "ptr"], returns: "void" },
    CFDictionaryGetTypeID: { args: [], returns: "u64" },
    CFDictionaryGetValue: { args: ["ptr", "ptr"], returns: "ptr" },
    CFDictionaryCreateMutableCopy: {
      args: ["ptr", "i64", "ptr"],
      returns: "ptr",
    },
    CFDictionarySetValue: { args: ["ptr", "ptr", "ptr"], returns: "void" },
    CFNumberGetTypeID: { args: [], returns: "u64" },
    CFNumberIsFloatType: { args: ["ptr"], returns: "u8" },
    CFNumberGetValue: { args: ["ptr", "i32", "buffer"], returns: "u8" },
    CFNumberCreate: { args: ["ptr", "i32", "buffer"], returns: "ptr" },
    CFURLCreateFromFileSystemRepresentation: {
      args: ["ptr", "buffer", "i64", "u8"],
      returns: "ptr",
    },
    CFReadStreamCreateWithFile: { args: ["ptr", "ptr"], returns: "ptr" },
    CFReadStreamOpen: { args: ["ptr"], returns: "u8" },
    CFReadStreamClose: { args: ["ptr"], returns: "void" },
    CFPropertyListCreateWithStream: {
      args: ["ptr", "ptr", "i64", "u64", "ptr", "buffer"],
      returns: "ptr",
    },
    CFPropertyListIsValid: { args: ["ptr", "i64"], returns: "u8" },
    CFErrorGetCode: { args: ["ptr"], returns: "i64" },
    // CoreFoundation arm64e, macOS 27.2.1 (26B131)
    // __copyValueForKey: dictionary lookup → CFRetain, or x0 = 0
    // The outer block also starts at NULL and has no error out parameter
    _CFPreferencesCopyValueWithContainer: {
      args: ["ptr", "ptr", "ptr", "ptr", "ptr"],
      returns: "ptr",
    },
    // The setter swaps key/value for setValue:forKey:… and tail-releases
    // its receiver. The source uses copyValues=1, not transfer of ownership
    _CFPreferencesSetValueWithContainer: {
      args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr"],
      returns: "void",
    },
    // The callback stores with strb and its caller reloads with ldrb
    // CFPrefsPlistSource tests _lastWriteFailed, _volatile and _readonly
    // and returns w0 & 1. It reports source state, not a durable flush
    _CFPreferencesSynchronizeWithContainer: {
      args: ["ptr", "ptr", "ptr", "ptr"],
      returns: "u8",
    },
  });
  const cf = library.symbols;
  // Create/Copy results are owned here, Get results and globals stay borrowed
  const owned: Pointer[] = [];
  let system: SystemLibrary | undefined;
  let frameworkHandle: Pointer | null = null;

  function own(value: Pointer | null, label: string): Pointer {
    if (value === null) throw new Error(`Cannot create or read ${label}`);
    owned.push(value);
    return value;
  }

  function close(): void {
    for (let value = owned.pop(); value !== undefined; value = owned.pop())
      cf.CFRelease(value);
    if (frameworkHandle !== null && system) system.symbols.dlclose(frameworkHandle);
    system?.close();
    library.close();
  }

  function size(value: bigint, label: string): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new Error(`Invalid ${label} size`);
    }
    return result;
  }

  // CoreFoundation's documented UTF-8 encoding and signed 64-bit number type
  const utf8 = 0x08000100;
  const sint64 = 4;
  const numberStorage = new BigUint64Array(1);

  function createString(value: string): Pointer {
    if (value.includes("\0"))
      throw new Error("CFString input contains a NUL character");
    return own(cf.CFStringCreateWithCString(null, value, utf8), "CFString");
  }

  function requireType(value: Pointer | null, type: bigint, label: string): Pointer {
    if (value === null || cf.CFGetTypeID(value) !== type) {
      throw new Error(`Invalid ${label} type`);
    }
    return value;
  }

  try {
    const types = {
      array: cf.CFArrayGetTypeID(),
      dictionary: cf.CFDictionaryGetTypeID(),
      string: cf.CFStringGetTypeID(),
      number: cf.CFNumberGetTypeID(),
    };

    function readString(value: Pointer | null, label: string): string {
      const reference = requireType(value, types.string, label);
      const length = cf.CFStringGetLength(reference);
      const capacity =
        size(cf.CFStringGetMaximumSizeForEncoding(length, utf8), label) + 1;
      const buffer = Buffer.allocUnsafe(capacity);
      if (!cf.CFStringGetCString(reference, ptr(buffer), BigInt(capacity), utf8)) {
        throw new Error(`Cannot decode ${label}`);
      }
      const decoded = buffer.toString("utf8", 0, buffer.indexOf(0));
      if (BigInt(decoded.length) !== length)
        throw new Error(`${label} contains an embedded NUL character`);
      return decoded;
    }

    function readNumber(value: Pointer | null, label: string): bigint {
      const reference = requireType(value, types.number, label);
      if (
        cf.CFNumberIsFloatType(reference) ||
        !cf.CFNumberGetValue(reference, sint64, numberStorage)
      ) {
        throw new Error(`${label} must be a signed 64-bit integer bit pattern`);
      }
      // The native number is signed, but the flags use all 64 bits
      return numberStorage[0] as bigint;
    }

    function createNumber(value: bigint): Pointer {
      numberStorage[0] = value;
      return own(cf.CFNumberCreate(null, sint64, numberStorage), "flags number");
    }

    system = dlopen("/usr/lib/libSystem.B.dylib", systemSymbols);
    // Resolve the exported CFString globals, not strings resembling their names
    const loader = system.symbols;
    const handle = loader.dlopen(framework, rtldLazy);
    if (handle === null) throw new Error("Cannot open CoreFoundation globals");
    frameworkHandle = handle;
    function global(name: string): Pointer {
      const symbol = loader.dlsym(handle, name);
      if (symbol === null) throw new Error(`Missing CoreFoundation global ${name}`);
      const value = read.u64(symbol);
      if (value === 0n || cf.CFGetTypeID(value) !== types.string) {
        throw new Error(`Invalid CoreFoundation string global ${name}`);
      }
      return value;
    }
    const user = global("kCFPreferencesCurrentUser");
    const host = global("kCFPreferencesAnyHost");

    function preference(
      key: string,
      { suite, container }: PreferenceDomain,
    ): ContainerPreference {
      // CFEqual(host, kCFPreferencesCurrentHost) drives the byHost flag
      // CFPrefsPlistSource receives the CFString container as containerPath:
      if (!isAbsolute(container))
        throw new Error("Preference container must be an absolute path");
      const keyRef = createString(key);
      const suiteRef = createString(suite);
      const containerRef = createString(container);
      return {
        copy() {
          const value = cf._CFPreferencesCopyValueWithContainer(
            keyRef,
            suiteRef,
            user,
            host,
            containerRef,
          );
          return value === null ? null : own(value, key);
        },
        set(value: Pointer) {
          // _CFPrefsValidateValueForKey checks the binary property-list format
          // Check it before the void setter, which also supports NULL deletion
          if (!cf.CFPropertyListIsValid(value, propertyListBinaryFormat))
            throw new Error(`Invalid property-list value for ${suite}:${key}`);
          cf._CFPreferencesSetValueWithContainer(
            keyRef,
            value,
            suiteRef,
            user,
            host,
            containerRef,
          );
        },
        synchronize() {
          const status = cf._CFPreferencesSynchronizeWithContainer(
            suiteRef,
            user,
            host,
            containerRef,
          );
          if (status === 1) return;
          if (status === 0)
            throw new Error(`Cannot synchronize preferences for ${suite}`);
          throw new Error(
            `Unexpected preferences synchronization status ${status} for ${suite}`,
          );
        },
      };
    }

    function readPropertyList(path: string, source: string): Pointer {
      const bytes = Buffer.from(path);
      const url = own(
        cf.CFURLCreateFromFileSystemRepresentation(
          null,
          bytes,
          BigInt(bytes.length),
          fileUrlIsDirectory,
        ),
        `${source} file URL`,
      );
      const stream = own(
        cf.CFReadStreamCreateWithFile(null, url),
        `${source} read stream`,
      );
      if (!cf.CFReadStreamOpen(stream))
        throw new Error(`Cannot open ${source} preferences`);
      try {
        const error = new BigUint64Array(1);
        const root = cf.CFPropertyListCreateWithStream(
          null,
          stream,
          readStreamToEnd,
          propertyListImmutable,
          null,
          error,
        );
        const errorReference = error[0] as bigint;
        if (errorReference !== 0n) owned.push(errorReference);
        if (root === null) {
          const code =
            errorReference === 0n ? "unknown" : cf.CFErrorGetCode(errorReference);
          throw new Error(`Cannot decode ${source} preferences (CF error ${code})`);
        }
        own(root, `${source} preferences`);
        return requireType(root, types.dictionary, `${source} preferences`);
      } finally {
        cf.CFReadStreamClose(stream);
      }
    }

    return {
      cf,
      types,
      preference,
      own,
      size,
      createString,
      requireType,
      readString,
      readNumber,
      createNumber,
      readPropertyList,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export function withCoreFoundation(
  run: (foundation: CoreFoundation) => undefined,
): void {
  const foundation = openCoreFoundation();
  try {
    run(foundation);
  } finally {
    foundation.close();
  }
}
