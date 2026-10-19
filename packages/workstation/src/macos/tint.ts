import { dlopen, linkSymbols, type Pointer } from "bun:ffi";
import { DotfilesError } from "../../../../lib/typescript/errors.ts";
import { rgbComponents } from "../lib/theme.ts";

export function applyIconTint(accent: string): void {
  const objc = dlopen("/usr/lib/libobjc.A.dylib", {
    objc_getClass: { args: ["cstring"], returns: "ptr" },
    sel_registerName: { args: ["cstring"], returns: "ptr" },
    objc_autoreleasePoolPush: { args: [], returns: "ptr" },
    objc_autoreleasePoolPop: { args: ["ptr"], returns: "void" },
  });
  const loader = dlopen("/usr/lib/system/libdyld.dylib", {
    dlopen: { args: ["cstring", "i32"], returns: "ptr" },
    dlsym: { args: ["ptr", "cstring"], returns: "ptr" },
  });
  const cstring = (value: string) => Buffer.from(`${value}\0`);
  const requirePointer = (
    value: Pointer | bigint | null,
    label: string,
  ): Pointer | bigint => {
    if (!value) throw new DotfilesError(`Could not load native ${label}`);
    return value;
  };
  const handle = requirePointer(
    loader.symbols.dlopen(cstring("/usr/lib/libobjc.A.dylib"), 2),
    "Objective-C runtime",
  );
  requirePointer(
    loader.symbols.dlopen(
      cstring("/System/Library/Frameworks/AppKit.framework/AppKit"),
      2,
    ),
    "AppKit",
  );
  requirePointer(
    loader.symbols.dlopen(
      cstring("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"),
      2,
    ),
    "SkyLight",
  );
  const message = requirePointer(
    loader.symbols.dlsym(handle, cstring("objc_msgSend")),
    "objc_msgSend",
  );
  // Objective-C message calls need one native signature per argument/return
  // shape; CGColor pointers must bypass JXA's Objective-C object conversion
  const send = linkSymbols({
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
  }).symbols;
  const klass = (name: string) =>
    requirePointer(objc.symbols.objc_getClass(cstring(name)), name);
  const selector = (name: string) =>
    requirePointer(objc.symbols.sel_registerName(cstring(name)), name);
  const pool = objc.symbols.objc_autoreleasePoolPush();
  try {
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
  } finally {
    objc.symbols.objc_autoreleasePoolPop(pool);
  }
}
