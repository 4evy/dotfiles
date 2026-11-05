import { type Pointer as BunPointer, dlopen, ptr, read } from "bun:ffi";

export type Pointer = BunPointer | bigint;

export interface CoreFoundation {
  cf: {
    CFEqual(left: Pointer, right: Pointer): number;
    CFArrayGetCount(value: Pointer): bigint;
    CFArrayGetValueAtIndex(value: Pointer, index: bigint): Pointer | null;
    CFArrayCreateMutableCopy(
      allocator: Pointer | null,
      capacity: bigint,
      value: Pointer | null,
    ): Pointer | null;
    CFArraySetValueAtIndex(value: Pointer, index: bigint, entry: Pointer): void;
    CFDictionaryGetValue(value: Pointer, key: Pointer): Pointer | null;
    CFDictionaryCreateMutableCopy(
      allocator: Pointer | null,
      capacity: bigint,
      value: Pointer,
    ): Pointer | null;
    CFDictionarySetValue(value: Pointer, key: Pointer, entry: Pointer): void;
    _CFPreferencesCopyValueWithContainer(
      key: Pointer,
      suite: Pointer,
      user: Pointer,
      host: Pointer,
      container: Pointer,
    ): Pointer | null;
    _CFPreferencesSetValueWithContainer(
      key: Pointer,
      value: Pointer,
      suite: Pointer,
      user: Pointer,
      host: Pointer,
      container: Pointer,
    ): void;
    _CFPreferencesSynchronizeWithContainer(
      suite: Pointer,
      user: Pointer,
      host: Pointer,
      container: Pointer,
    ): number;
  };
  types: { array: bigint; dictionary: bigint; string: bigint; number: bigint };
  user: Pointer;
  host: Pointer;
  own(value: Pointer | null, label: string): Pointer;
  size(value: bigint, label: string): number;
  createString(value: string): Pointer;
  requireType(value: Pointer | null, type: bigint, label: string): Pointer;
  readString(value: Pointer | null, label: string): string;
  readNumber(value: Pointer | null, label: string): bigint;
  createNumber(value: bigint): Pointer;
  readPropertyList(path: string, source: string): Pointer;
  close(): void;
}
type SystemLibrary = {
  symbols: {
    dlopen(path: string, mode: number): Pointer | null;
    dlsym(handle: Pointer | null, name: string): Pointer | null;
    dlclose(handle: Pointer): number;
  };
  close(): void;
};

const framework =
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

function openCoreFoundation(): CoreFoundation {
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
    CFErrorGetCode: { args: ["ptr"], returns: "i64" },
    _CFPreferencesCopyValueWithContainer: {
      args: ["ptr", "ptr", "ptr", "ptr", "ptr"],
      returns: "ptr",
    },
    _CFPreferencesSetValueWithContainer: {
      args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr"],
      returns: "void",
    },
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
    if (frameworkHandle !== null && system)
      system.symbols.dlclose(frameworkHandle);
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
  const numberStorage = new BigInt64Array(1);

  function createString(value: string): Pointer {
    return own(cf.CFStringCreateWithCString(null, value, utf8), "CFString");
  }

  function requireType(
    value: Pointer | null,
    type: bigint,
    label: string,
  ): Pointer {
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
      if (
        !cf.CFStringGetCString(reference, ptr(buffer), BigInt(capacity), utf8)
      ) {
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
      // Read and box signed int64 storage while preserving all unsigned flags bits
      return BigInt.asUintN(64, numberStorage[0] as bigint);
    }

    function createNumber(value: bigint): Pointer {
      numberStorage[0] = BigInt.asIntN(64, value);
      return own(
        cf.CFNumberCreate(null, sint64, numberStorage),
        "flags number",
      );
    }

    system = dlopen("/usr/lib/libSystem.B.dylib", {
      dlopen: { args: ["cstring", "i32"], returns: "ptr" },
      dlsym: { args: ["ptr", "cstring"], returns: "ptr" },
      dlclose: { args: ["ptr"], returns: "i32" },
    });
    const loader = system;
    // Resolve the exported CFString globals, not strings resembling their names
    frameworkHandle = system.symbols.dlopen(framework, 1);
    if (frameworkHandle === null)
      throw new Error("Cannot open CoreFoundation globals");
    function global(name: string): Pointer {
      const symbol = loader.symbols.dlsym(frameworkHandle, name);
      if (symbol === null)
        throw new Error(`Missing CoreFoundation global ${name}`);
      const address = typeof symbol === "bigint" ? Number(symbol) : symbol;
      if (!Number.isSafeInteger(address))
        throw new Error(`Unrepresentable CoreFoundation global ${name}`);
      const value = read.ptr(address);
      if (value === 0) throw new Error(`Null CoreFoundation global ${name}`);
      return value as BunPointer;
    }
    const user = global("kCFPreferencesCurrentUser");
    const host = global("kCFPreferencesAnyHost");

    function readPropertyList(path: string, source: string): Pointer {
      const bytes = Buffer.from(path);
      const url = own(
        cf.CFURLCreateFromFileSystemRepresentation(
          null,
          bytes,
          BigInt(bytes.length),
          0,
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
          0n,
          0n,
          null,
          error,
        );
        const errorReference = read.ptr(ptr(error)) as BunPointer;
        if (errorReference !== 0) owned.push(errorReference);
        if (root === null) {
          const code =
            errorReference === 0
              ? "unknown"
              : cf.CFErrorGetCode(errorReference);
          throw new Error(
            `Cannot decode ${source} preferences (CF error ${code})`,
          );
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
      user,
      host,
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

export function withCoreFoundation<T>(
  run: (foundation: CoreFoundation) => T,
): T {
  const foundation = openCoreFoundation();
  try {
    return run(foundation);
  } finally {
    foundation.close();
  }
}
