/// <reference types="frida-gum" />
// Loaded inside GUI processes by macos-catppuccin-custom-accent
// CoreUI Copy functions return +1 colors. Never replace borrowed cgColor getters
/** @type {ReturnType<typeof createState> | undefined} */
let state;

/** @param {Module} module */
function catalogHashPoint(module) {
  if (Process.arch !== "arm64") {
    throw new Error("Unsupported SwiftUI catalog cache architecture");
  }
  const start = module.findSymbolByName(
    "$s7SwiftUI11ObjectCacheCyq_xcigAA17CatalogAppearanceV05ColorD3Key33_D5261B14264A5DF0B53BDE4A9E2F71F9LLV_So10CGColorRefaSgTB5",
  );
  if (!start) throw new Error("Unrecognized SwiftUI catalog cache specialization");
  const points = [];
  for (let address = start; address.compare(start.add(0x200)) < 0; ) {
    const instruction = Instruction.parse(address);
    if (instruction.mnemonic === "bl") {
      const next = Instruction.parse(instruction.next);
      const bucket = Instruction.parse(next.next);
      const lock = Instruction.parse(bucket.next);
      if (
        next.toString() === "mov x23, x0" &&
        bucket.toString() === "ubfiz x24, x0, #2, #3" &&
        lock.toString() === "add x0, x19, #0x20"
      )
        points.push(instruction.next);
    }
    address = instruction.next;
  }
  if (points.length !== 1) {
    throw new Error("Unrecognized SwiftUI catalog hash instruction sequence");
  }
  return /** @type {NativePointer} */ (points[0]);
}

/**
 * @param {Module} appkit
 * @param {NativePointer} application
 * @param {string} hex
 */
function createState(appkit, application, hex) {
  const objc = Process.getModuleByName("libobjc.A.dylib");
  const graphics = Process.getModuleByName("CoreGraphics");
  const core = Process.getModuleByName("CoreFoundation");
  const dispatch = Process.getModuleByName("libdispatch.dylib");
  const ui = Process.getModuleByName("CoreUI");
  const nil = ptr(0);
  const getClass = new NativeFunction(
    objc.getExportByName("objc_getClass"),
    "pointer",
    ["pointer"],
  );
  const register = new NativeFunction(
    objc.getExportByName("sel_registerName"),
    "pointer",
    ["pointer"],
  );
  /** @param {string} name */
  const selector = (name) => register(Memory.allocUtf8String(name));
  /** @param {string} name */
  const cls = (name) => getClass(Memory.allocUtf8String(name));
  const message = objc.getExportByName("objc_msgSend");
  const pointer = new NativeFunction(message, "pointer", ["pointer", "pointer"]);
  const argument = new NativeFunction(message, "pointer", [
    "pointer",
    "pointer",
    "pointer",
  ]);
  const notification = new NativeFunction(message, "void", [
    "pointer",
    "pointer",
    "pointer",
    "pointer",
  ]);
  const numbers = new NativeFunction(message, "void", [
    "pointer",
    "pointer",
    "pointer",
    "pointer",
    "pointer",
    "pointer",
  ]);
  const createColor = new NativeFunction(
    graphics.getExportByName("CGColorCreateSRGB"),
    "pointer",
    ["double", "double", "double", "double"],
  );
  const retain = new NativeFunction(
    graphics.getExportByName("CGColorRetain"),
    "pointer",
    ["pointer"],
  );
  const release = new NativeFunction(core.getExportByName("CFRelease"), "void", [
    "pointer",
  ]);
  const equal = new NativeFunction(
    core.getExportByName("CFEqual"),
    "uchar",
    ["pointer", "pointer"],
    { traps: "none" },
  );
  const getAccent = new NativeFunction(
    appkit.getExportByName("NSColorGetUserAccentColor"),
    "long",
    [],
    { traps: "none" },
  );
  const random = new NativeFunction(
    Module.getGlobalExportByName("arc4random_buf"),
    "void",
    ["pointer", "size_t"],
  );
  const randomBytes = Memory.alloc(Process.pointerSize);
  const queue = dispatch.getExportByName("_dispatch_main_q");
  const dispatchAsync = new NativeFunction(
    dispatch.getExportByName("dispatch_async_f"),
    "void",
    ["pointer", "pointer", "pointer"],
  );
  const colorClass = cls("NSColor");
  const dynamicColors = cls("NSDynamicSystemColor");
  if (dynamicColors.isNull()) throw new Error("NSDynamicSystemColor unavailable");
  const colorSpace = pointer(cls("NSColorSpace"), selector("sRGBColorSpace"));
  const center = pointer(cls("NSNotificationCenter"), selector("defaultCenter"));
  const changed = ui
    .getExportByName("kCUINotificationAquaColorVariantChanged")
    .readPointer();
  const controlAccent = selector("controlAccentColor");
  const useColorSpace = selector("colorUsingColorSpace:");
  const getComponents = selector("getRed:green:blue:alpha:");
  const recache = selector("recacheAllColors:");
  const invalidate = selector("_invalidateWindowAppearances");
  const post = selector("postNotificationName:object:");
  const components = Memory.alloc(32);
  /** @type {InvocationListener[]} */
  const hooks = [];
  /** @type {NativePointer[]} */
  const names = [];
  // At most install and dispose. Keep callbacks alive until native frames unwind
  /** @type {NativePointer[]} */
  const callbacks = [];
  /** @type {ModuleObserver | undefined} */
  let observer;
  let accent = nil;
  let salt = newSalt(nil);
  /** @type {Promise<{restored: number[]}> | undefined} */
  let disposal;
  /** @type {Promise<{supported: boolean, reason?: string, before?: number[], after?: number[], selected?: number}> | undefined} */
  let installation;
  let cancelled = false;
  /** @type {InvocationListener | undefined} */
  let hashHook;

  /** @param {NativePointer} previous */
  function newSalt(previous) {
    let value;
    do {
      random(randomBytes, Process.pointerSize);
      value = randomBytes.readPointer();
    } while (value.isNull() || value.equals(previous));
    return value;
  }

  /**
   * @template T
   * @param {() => T} work
   * @returns {Promise<T>}
   */
  function onMain(work) {
    return new Promise((resolve, reject) => {
      Script.pin();
      const callback = new NativeCallback(
        () => {
          try {
            const result = work();
            Script.nextTick(() => {
              resolve(result);
              Script.unpin();
            });
          } catch (error) {
            Script.nextTick(() => {
              reject(error);
              Script.unpin();
            });
          }
        },
        "void",
        ["pointer"],
      );
      callbacks.push(callback);
      dispatchAsync(queue, nil, callback);
    });
  }

  function currentColor() {
    const color = argument(
      pointer(colorClass, controlAccent),
      useColorSpace,
      colorSpace,
    );
    numbers(
      color,
      getComponents,
      components,
      components.add(8),
      components.add(16),
      components.add(24),
    );
    return [0, 8, 16].map((offset) =>
      Math.round(components.add(offset).readDouble() * 255),
    );
  }

  function redraw() {
    argument(dynamicColors, recache, nil);
    notification(center, post, changed, nil);
    pointer(application, invalidate);
  }

  function detach() {
    observer?.detach();
    observer = undefined;
    for (const hook of hooks.splice(0)) hook.detach();
    hashHook?.detach();
    hashHook = undefined;
    Interceptor.flush();
  }

  function releaseOwned() {
    for (const name of names.splice(0)) release(name);
    if (!accent.isNull()) {
      release(accent);
      accent = nil;
    }
  }

  /** @param {Module} module */
  function installHash(module, point = catalogHashPoint(module)) {
    if (hashHook || cancelled) return;
    // SwiftUI inlines hashValue and keeps CGColors in a static ObjectCache
    // Change only this cache's completed hash, not Swift object storage
    // A fresh salt on each installation also invalidates previous palette values
    hashHook = Interceptor.attach(point, {
      onEnter() {
        const context = /** @type {Arm64CpuContext} */ (this.context);
        context.x0 = context.x0.xor(salt);
      },
    });
  }

  return {
    hex,
    install() {
      if (installation) return installation;
      installation = onMain(() => {
        if (cancelled) return { supported: false, reason: "Agent disposed" };
        const swiftui = Process.findModuleByName("SwiftUICore");
        // Validate the private instruction shape before modifying color resolution
        const point = swiftui ? catalogHashPoint(swiftui) : undefined;
        const before = currentColor();
        try {
          if (swiftui) installHash(swiftui, point);
          else
            observer = Process.attachModuleObserver({
              onAdded(module) {
                if (module.name !== "SwiftUICore" || cancelled) return;
                try {
                  installHash(module);
                } catch (error) {
                  cancelled = true;
                  detach();
                  throw error;
                }
              },
            });
          const rgb = Number.parseInt(hex.slice(1), 16);
          accent = createColor(
            (rgb >>> 16) / 255,
            ((rgb >>> 8) & 255) / 255,
            (rgb & 255) / 255,
            1,
          );
          if (accent.isNull()) throw new Error("CGColorCreateSRGB failed");
          const stringClass = cls("NSString");
          const fromUtf8 = selector("stringWithUTF8String:");
          const retainObject = selector("retain");
          /** @param {string} name */
          const ownName = (name) => {
            const value = pointer(
              argument(stringClass, fromUtf8, Memory.allocUtf8String(name)),
              retainObject,
            );
            names.push(value);
            return value;
          };
          const pinkName = ownName("controlAccentPinkColor");
          const privatePinkName = ownName("privateControlAccentPinkColor");
          const accentName = ownName("controlAccentColor");
          for (const name of ["CUICopyCustomColor", "CUICopyCustomColorWithOptions"]) {
            hooks.push(
              Interceptor.attach(ui.getExportByName(name), {
                onEnter(args) {
                  const name = /** @type {NativePointer} */ (args[1]);
                  this.pink =
                    !name.isNull() &&
                    (equal(name, pinkName) ||
                      equal(name, privatePinkName) ||
                      (equal(name, accentName) && Number(getAccent()) === 6));
                },
                onLeave(result) {
                  if (!this.pink || result.isNull() || result.equals(accent)) return;
                  const original = ptr(result.toString());
                  result.replace(retain(accent));
                  release(original);
                },
              }),
            );
          }
          salt = newSalt(salt);
          Interceptor.flush();
          redraw();
          return {
            supported: true,
            before,
            after: currentColor(),
            selected: Number(getAccent()),
          };
        } catch (error) {
          cancelled = true;
          detach();
          try {
            redraw();
          } finally {
            releaseOwned();
          }
          throw error;
        }
      });
      return installation;
    },
    dispose() {
      if (disposal) return disposal;
      cancelled = true;
      // Detach synchronously even when a busy main queue delays recaching
      detach();
      disposal = onMain(() => {
        try {
          redraw();
          return { restored: currentColor() };
        } finally {
          releaseOwned();
        }
      });
      return disposal;
    },
  };
}

rpc.exports = {
  /** @param {string} hex */
  install(hex) {
    if (!/^#[\da-f]{6}$/i.test(hex))
      throw new Error("Expected a six-digit sRGB accent");
    if (state) {
      if (state.hex !== hex)
        throw new Error("Accent already installed with a different palette");
      return state.install();
    }
    const appkit = Process.findModuleByName("AppKit");
    if (!appkit) return { supported: false, reason: "AppKit not loaded" };
    const application = appkit.getExportByName("NSApp").readPointer();
    if (application.isNull()) return { supported: false, reason: "AppKit not ready" };
    state = createState(appkit, application, hex);
    return state.install();
  },
  dispose() {
    return state?.dispose() ?? { disposed: true };
  },
};
