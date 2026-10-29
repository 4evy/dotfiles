import { dlopen, linkSymbols, type Pointer } from "bun:ffi";
import { DotfilesError } from "@dotfiles/core/errors";
import { rgbComponents } from "@dotfiles/workstation/theme";
import { Effect } from "effect";

const nativeCall = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof DotfilesError ? cause : new DotfilesError(String(cause)),
  });

export const applyIconTint = Effect.fn("applyIconTint")(function* (accent: string) {
  const objc = yield* Effect.acquireRelease(
    nativeCall(() =>
      dlopen("/usr/lib/libobjc.A.dylib", {
        objc_getClass: { args: ["cstring"], returns: "ptr" },
        sel_registerName: { args: ["cstring"], returns: "ptr" },
        objc_autoreleasePoolPush: { args: [], returns: "ptr" },
        objc_autoreleasePoolPop: { args: ["ptr"], returns: "void" },
      }),
    ),
    (library) => Effect.sync(() => library.close()),
  );
  const loader = yield* Effect.acquireRelease(
    nativeCall(() =>
      dlopen("/usr/lib/system/libdyld.dylib", {
        dlopen: { args: ["cstring", "i32"], returns: "ptr" },
        dlsym: { args: ["ptr", "cstring"], returns: "ptr" },
        dlclose: { args: ["ptr"], returns: "i32" },
      }),
    ),
    (library) => Effect.sync(() => library.close()),
  );
  const cstring = (value: string) => Buffer.from(`${value}\0`);
  const requirePointer = (
    value: Pointer | bigint | null,
    label: string,
  ): Pointer | bigint => {
    if (!value) throw new DotfilesError(`Could not load native ${label}`);
    return value;
  };
  const openLibrary = (path: string, label: string) =>
    Effect.acquireRelease(
      nativeCall(() => requirePointer(loader.symbols.dlopen(cstring(path), 2), label)),
      (handle) =>
        Effect.sync(() => {
          loader.symbols.dlclose(handle);
        }),
    );
  const handle = yield* openLibrary("/usr/lib/libobjc.A.dylib", "Objective-C runtime");
  yield* openLibrary("/System/Library/Frameworks/AppKit.framework/AppKit", "AppKit");
  yield* openLibrary(
    "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
    "SkyLight",
  );
  const message = yield* nativeCall(() =>
    requirePointer(
      loader.symbols.dlsym(handle, cstring("objc_msgSend")),
      "objc_msgSend",
    ),
  );
  // Objective-C message calls need one native signature per argument/return
  // shape; CGColor pointers must bypass JXA's Objective-C object conversion
  const messages = yield* Effect.acquireRelease(
    nativeCall(() =>
      linkSymbols({
        pointer: { ptr: message, args: ["ptr", "ptr"], returns: "ptr" },
        pointerArgument: { ptr: message, args: ["ptr", "ptr", "ptr"], returns: "ptr" },
        color: {
          ptr: message,
          args: ["ptr", "ptr", "f64", "f64", "f64", "f64"],
          returns: "ptr",
        },
        integer: { ptr: message, args: ["ptr", "ptr", "i64"], returns: "void" },
        object: { ptr: message, args: ["ptr", "ptr", "ptr"], returns: "void" },
        void: { ptr: message, args: ["ptr", "ptr"], returns: "void" },
        notification: {
          ptr: message,
          args: ["ptr", "ptr", "ptr", "ptr", "ptr", "bool"],
          returns: "void",
        },
      }),
    ),
    (library) => Effect.sync(() => library.close()),
  );
  const send = messages.symbols;
  const klass = (name: string) =>
    requirePointer(objc.symbols.objc_getClass(cstring(name)), name);
  const selector = (name: string) =>
    requirePointer(objc.symbols.sel_registerName(cstring(name)), name);
  yield* Effect.acquireRelease(
    nativeCall(() => objc.symbols.objc_autoreleasePoolPush()),
    (pool) => Effect.sync(() => objc.symbols.objc_autoreleasePoolPop(pool)),
  );
  yield* nativeCall(() => {
    const configuration = requirePointer(
      send.pointer(
        klass("SLSIconAppearanceConfiguration"),
        selector("fetchCurrentIconAppearanceConfiguration"),
      ),
      "icon appearance configuration",
    );
    const [red, green, blue] = rgbComponents(accent);
    const color = requirePointer(
      send.color(
        klass("NSColor"),
        selector("colorWithSRGBRed:green:blue:alpha:"),
        red,
        green,
        blue,
        1,
      ),
      "NSColor",
    );
    const cgColor = requirePointer(send.pointer(color, selector("CGColor")), "CGColor");
    send.integer(configuration, selector("setIconTintColorName:"), 10);
    send.object(configuration, selector("setOtherIconTintColor:"), cgColor);
    send.void(configuration, selector("save"));
    const center = requirePointer(
      send.pointer(klass("NSDistributedNotificationCenter"), selector("defaultCenter")),
      "notification center",
    );
    const name = requirePointer(
      send.pointerArgument(
        klass("NSString"),
        selector("stringWithUTF8String:"),
        cstring("AppleColorPreferencesChangedNotification"),
      ),
      "notification name",
    );
    send.notification(
      center,
      selector("postNotificationName:object:userInfo:deliverImmediately:"),
      name,
      null,
      null,
      true,
    );
  });
}, Effect.scoped);
