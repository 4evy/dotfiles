#!/usr/bin/env bun
import { CString, dlopen, ptr, read } from "bun:ffi";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { object } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { flag, option } from "@optique/core/primitives";
import { choice, string, type ValueParser } from "@optique/core/valueparser";
import { Effect } from "effect";
import { parseDarwinOptions } from "../cli.ts";

// hidapi is a synchronous native ABI, kept behind narrow typed adapters
const native = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (cause) =>
      new DotfilesError(cause instanceof Error ? cause.message : String(cause)),
  });

const SOFTWARE_ID = 0x0b;
const MULTIPLATFORM = 0x4531;
const LOGITECH_VENDOR_ID = 0x046d;
const HID_IDENTIFIER_MAX = 0xffff;
const PLATFORM_INDEX_MAX = 0xff;
const DARWIN_WCHAR_BYTES = 4;
// hid_device_info field offsets in the 64-bit Darwin C ABI
// The appended bus_type field in hidapi 0.13 does not change them
const HID_DEVICE_INFO = {
  pathOffset: 0,
  productStringOffset: 40,
  usagePageOffset: 48,
  nextOffset: 56,
} as const;
const HID_USAGE_PAGE = {
  logitechHidpp: 0xff43,
  logitechVendor: 0xff0c,
  genericDesktop: 0x0001,
  consumer: 0x000c,
} as const;
const UNKNOWN_USAGE_PAGE_PRIORITY = 9;
const HID_READ_BUFFER_BYTES = 32;
const REQUEST_TIMEOUT_MS = 4000;
const HID_OPEN_SHARED = 0;
const READ_POLL_MAX_MS = 50;
const READ_POLL_MIN_MS = 1;
const NONBLOCKING_READ_TIMEOUT_MS = 0;
const HIDPP = {
  longReportId: 0x11,
  longReportBytes: 20,
  reportIdOffset: 0,
  deviceOffset: 1,
  requestOffset: 2,
  parametersOffset: 4,
  parametersBytes: 16,
  targetDeviceIndex: 0xff,
  alternateReplyDeviceIndex: 0,
  functionMask: 0xfff0,
  featureShift: 8,
  rootGetFeature: 0,
  featureIdBytes: 2,
  featureIndexOffset: 0,
  errorTagOffset: 0,
  errorTag: 0xff,
  errorRequestOffset: 1,
  errorCodeOffset: 3,
  replyRequestOffset: 0,
  replyParametersOffset: 2,
} as const;
const MULTIPLATFORM_INFO = {
  minimumBytes: 7,
  capabilitiesOffset: 0,
  writableMask: 0x02,
  descriptorCountOffset: 2,
  currentPlatformOffset: 6,
  getInfo: 0,
  getDescriptor: 0x10,
  setPlatform: 0x30,
  currentHost: 0xff,
} as const;
const PLATFORM_DESCRIPTOR = {
  minimumBytes: 8,
  platformOffset: 0,
  osFlagsOffset: 2,
} as const;
const OS_BITS = {
  windows: 0x0100,
  linux: 0x0400,
  chrome: 0x0800,
  android: 0x1000,
  macos: 0x2000,
  ios: 0x4000,
  webos: 0x8000,
} as const;
type OsName = keyof typeof OS_BITS;
interface Device {
  path: string;
  product: string;
  usagePage: number;
}
interface Descriptor {
  platform: number;
  osFlags: number;
}
interface Transport {
  read(timeoutMs: number): Effect.Effect<Buffer, DotfilesError>;
  write(data: Buffer): Effect.Effect<void, DotfilesError>;
}

function wideString(pointer: number | bigint | null): string {
  if (!pointer) return "";
  // Darwin wchar_t is UTF-32, unlike JavaScript's UTF-16 strings
  let result = "";
  for (let offset = 0; ; offset += DARWIN_WCHAR_BYTES) {
    const codePoint = read.u32(pointer, offset);
    if (codePoint === 0) return result;
    result += String.fromCodePoint(codePoint);
  }
}

function loadHidapi() {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("This helper requires 64-bit macOS");
  }
  const symbols = {
    hid_init: { args: [], returns: "i32" },
    hid_exit: { args: [], returns: "i32" },
    hid_enumerate: { args: ["u16", "u16"], returns: "ptr" },
    hid_free_enumeration: { args: ["ptr"], returns: "void" },
    hid_open_path: { args: ["ptr"], returns: "ptr" },
    hid_write: { args: ["ptr", "ptr", "u64"], returns: "i32" },
    hid_read_timeout: { args: ["ptr", "ptr", "u64", "i32"], returns: "i32" },
    hid_close: { args: ["ptr"], returns: "void" },
    hid_error: { args: ["ptr"], returns: "ptr" },
    hid_darwin_set_open_exclusive: { args: ["i32"], returns: "void" },
  } as const;
  for (const candidate of [
    "/opt/homebrew/lib/libhidapi.dylib",
    "/usr/local/lib/libhidapi.dylib",
    "libhidapi.dylib",
  ]) {
    try {
      return dlopen(candidate, symbols);
    } catch {
      /* Try the next library location */
    }
  }
  throw new Error("could not load libhidapi; install Homebrew package 'hidapi'");
}

function choosePath(devices: Device[], productName?: string): string | undefined {
  const priority = new Map<number, number>([
    [HID_USAGE_PAGE.logitechHidpp, 0],
    [HID_USAGE_PAGE.logitechVendor, 1],
    [HID_USAGE_PAGE.genericDesktop, 2],
    [HID_USAGE_PAGE.consumer, 3],
  ]);
  return devices
    .filter((device) => !productName || device.product === productName)
    .sort(
      (left, right) =>
        (priority.get(left.usagePage) ?? UNKNOWN_USAGE_PAGE_PRIORITY) -
        (priority.get(right.usagePage) ?? UNKNOWN_USAGE_PAGE_PRIORITY),
    )[0]?.path;
}

const request = Effect.fn(function* (
  transport: Transport,
  requestId: number,
  params = Buffer.alloc(0),
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  requestId = (requestId & HIDPP.functionMask) | SOFTWARE_ID;
  const frame = Buffer.alloc(HIDPP.longReportBytes);
  frame[HIDPP.reportIdOffset] = HIDPP.longReportId;
  frame[HIDPP.deviceOffset] = HIDPP.targetDeviceIndex;
  frame.writeUInt16BE(requestId, HIDPP.requestOffset);
  params.copy(frame, HIDPP.parametersOffset, 0, HIDPP.parametersBytes);
  while ((yield* transport.read(NONBLOCKING_READ_TIMEOUT_MS)).length) {
    /* Discard stale replies before sending */
  }
  yield* transport.write(frame);
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    // Bound native blocking so cancellation is observed between reads
    const data = yield* transport.read(
      Math.floor(
        Math.min(
          READ_POLL_MAX_MS,
          Math.max(READ_POLL_MIN_MS, deadline - performance.now()),
        ),
      ),
    );
    if (
      data.length !== HIDPP.longReportBytes ||
      data[HIDPP.reportIdOffset] !== HIDPP.longReportId ||
      (data[HIDPP.deviceOffset] !== HIDPP.targetDeviceIndex &&
        data[HIDPP.deviceOffset] !== HIDPP.alternateReplyDeviceIndex)
    )
      continue;
    const payload = data.subarray(HIDPP.requestOffset);
    if (
      payload[HIDPP.errorTagOffset] === HIDPP.errorTag &&
      payload.readUInt16BE(HIDPP.errorRequestOffset) === requestId
    ) {
      return yield* Effect.fail(
        new DotfilesError(
          `HID++ feature request 0x${requestId.toString(16).padStart(4, "0")} failed with error 0x${payload[HIDPP.errorCodeOffset]?.toString(16).padStart(2, "0")}`,
        ),
      );
    }
    if (payload.readUInt16BE(HIDPP.replyRequestOffset) === requestId)
      return payload.subarray(HIDPP.replyParametersOffset);
  }
  return yield* Effect.fail(
    new DotfilesError(
      `timed out waiting for HID++ request 0x${requestId.toString(16).padStart(4, "0")}`,
    ),
  );
});

const featureIndex = Effect.fn(function* (transport: Transport, feature: number) {
  const parameter = Buffer.alloc(HIDPP.featureIdBytes);
  parameter.writeUInt16BE(feature);
  return (
    (yield* request(transport, HIDPP.rootGetFeature, parameter))[
      HIDPP.featureIndexOffset
    ] || undefined
  );
});

function choosePlatform(
  descriptors: Descriptor[],
  platform?: number,
  os?: OsName,
): number {
  if (platform !== undefined) return platform;
  if (!os) throw new Error("either --platform or --os is required");
  const descriptor = descriptors.find(({ osFlags }) => osFlags & OS_BITS[os]);
  if (!descriptor)
    throw new Error(`keyboard does not advertise an OS platform for ${os}`);
  return descriptor.platform;
}

const setMultiplatform = Effect.fn(function* (
  transport: Transport,
  platform?: number,
  os?: OsName,
) {
  const index = yield* featureIndex(transport, MULTIPLATFORM);
  if (index === undefined) {
    console.log("logitech-platform: MULTIPLATFORM feature is not available");
    return false;
  }
  const indexRequest = index << HIDPP.featureShift;
  const info = yield* request(transport, indexRequest | MULTIPLATFORM_INFO.getInfo);
  if (info.length < MULTIPLATFORM_INFO.minimumBytes)
    return yield* Effect.fail(
      new DotfilesError(
        `unexpected MULTIPLATFORM info payload: ${info.toString("hex")}`,
      ),
    );
  if (
    !(
      (info[MULTIPLATFORM_INFO.capabilitiesOffset] ?? 0) &
      MULTIPLATFORM_INFO.writableMask
    )
  ) {
    console.log("logitech-platform: keyboard reports MULTIPLATFORM as read-only");
    return false;
  }
  const descriptors: Descriptor[] = [];
  for (
    let descriptor = 0;
    descriptor < (info[MULTIPLATFORM_INFO.descriptorCountOffset] ?? 0);
    descriptor++
  ) {
    const reply = yield* request(
      transport,
      indexRequest | MULTIPLATFORM_INFO.getDescriptor,
      Buffer.from([descriptor]),
    );
    if (reply.length >= PLATFORM_DESCRIPTOR.minimumBytes)
      descriptors.push({
        platform: reply.readUInt8(PLATFORM_DESCRIPTOR.platformOffset),
        osFlags: reply.readUInt16BE(PLATFORM_DESCRIPTOR.osFlagsOffset),
      });
  }
  const desired = yield* native(() => choosePlatform(descriptors, platform, os));
  const description = descriptors
    .map(({ platform, osFlags }) => {
      const names = Object.entries(OS_BITS)
        .filter(([, bit]) => osFlags & bit)
        .map(([name]) => name);
      return `${platform}:${names.join("/") || `0x${osFlags.toString(16)}`}`;
    })
    .join(", ");
  console.log(
    `logitech-platform: current=${info[MULTIPLATFORM_INFO.currentPlatformOffset]} desired=${desired} descriptors=[${description}]`,
  );
  if (info[MULTIPLATFORM_INFO.currentPlatformOffset] === desired) {
    console.log("logitech-platform: already configured");
    return false;
  }
  yield* request(
    transport,
    indexRequest | MULTIPLATFORM_INFO.setPlatform,
    Buffer.from([MULTIPLATFORM_INFO.currentHost, desired]),
  );
  const updated = yield* request(transport, indexRequest | MULTIPLATFORM_INFO.getInfo);
  if (
    updated.length < MULTIPLATFORM_INFO.minimumBytes ||
    updated[MULTIPLATFORM_INFO.currentPlatformOffset] !== desired
  )
    return yield* Effect.fail(
      new DotfilesError(
        `MULTIPLATFORM write did not stick: ${updated.toString("hex")}`,
      ),
    );
  console.log("logitech-platform: updated current host platform");
  return true;
});

// HID identifiers and platform indices accept both decimal and hexadecimal
function integer(option: string, max: number): ValueParser<"sync", number> {
  return {
    mode: "sync",
    metavar: "INTEGER",
    placeholder: 0,
    parse(value) {
      if (!/^(?:0x[\da-f]+|\d+)$/i.test(value))
        return { success: false, error: message`${option} must be an integer` };
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > max)
        return {
          success: false,
          error: message`${option} must be between 0 and ${String(max)}`,
        };
      return { success: true, value: parsed };
    },
    format: String,
  };
}

const parser = object({
  vendor: option("--vendor-id", integer("--vendor-id", HID_IDENTIFIER_MAX))
    .multiple()
    .map((values) => values.at(-1) ?? LOGITECH_VENDOR_ID),
  product: option("--product-id", integer("--product-id", HID_IDENTIFIER_MAX))
    .multiple({ min: 1 })
    .map((values) => {
      const product = values.at(-1);
      if (product === undefined) throw new Error("Product ID is required");
      return product;
    }),
  productName: option("--product-name", string({ metavar: "NAME" }))
    .multiple()
    .map((values) => values.at(-1)),
  platform: option("--platform", integer("--platform", PLATFORM_INDEX_MAX))
    .multiple()
    .map((values) => values.at(-1)),
  os: option(
    "--os",
    choice(["windows", "linux", "chrome", "android", "macos", "ios", "webos"]),
  )
    .multiple()
    .map((values) => values.at(-1)),
  strict: flag("--strict")
    .multiple()
    .map((values) => values.length > 0),
});

function parseOptions() {
  return parseDarwinOptions(
    parser,
    "bun logitech.ts",
    Bun.argv.slice(2),
    message`Set a Logitech keyboard's MULTIPLATFORM host mode`,
  );
}

type HidApi = ReturnType<typeof loadHidapi>["symbols"];
type Handle = NonNullable<ReturnType<HidApi["hid_open_path"]>>;

const enumerateDevices = Effect.fn(function* (
  api: HidApi,
  vendor: number,
  product: number,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const head = yield* Effect.acquireRelease(
        native(() => api.hid_enumerate(vendor, product)),
        (head) =>
          Effect.sync(() => {
            if (head) api.hid_free_enumeration(head);
          }),
      );
      return yield* native(() => {
        const devices: Device[] = [];
        for (
          let current: number | bigint | null = head;
          current;
          current = read.ptr(current, HID_DEVICE_INFO.nextOffset)
        ) {
          const path = read.ptr(current, HID_DEVICE_INFO.pathOffset);
          if (path)
            devices.push({
              path: new CString(path).toString(),
              product: wideString(
                read.ptr(current, HID_DEVICE_INFO.productStringOffset),
              ),
              usagePage: read.u16(current, HID_DEVICE_INFO.usagePageOffset),
            });
        }
        return devices;
      });
    }),
  );
});

function openDevice(api: HidApi, path: string): Handle {
  const pathBuffer = Buffer.from(`${path}\0`);
  const handle = api.hid_open_path(ptr(pathBuffer));
  if (handle) return handle;
  let message = wideString(api.hid_error(null)) || "unknown hidapi error";
  if (message.includes("not permitted"))
    message += "; grant Input Monitoring to the terminal running dotfiles setup";
  else if (message.includes("exclusive access"))
    message += "; stop Kanata before changing Logitech platform mode";
  throw new Error(message);
}

function nativeTransport(api: HidApi, handle: Handle): Transport {
  return {
    read(timeoutMs) {
      return native(() => {
        const buffer = Buffer.alloc(HID_READ_BUFFER_BYTES);
        const size = api.hid_read_timeout(
          handle,
          ptr(buffer),
          buffer.length,
          timeoutMs,
        );
        if (size < 0)
          throw new Error(wideString(api.hid_error(handle)) || "unknown hidapi error");
        return buffer.subarray(0, size);
      });
    },
    write(data) {
      return native(() => {
        const written = api.hid_write(handle, ptr(data), data.length);
        if (written < 0)
          throw new Error(wideString(api.hid_error(handle)) || "unknown hidapi error");
        if (written !== data.length)
          throw new Error(`Incomplete HID write: ${written}/${data.length}`);
      });
    },
  };
}

export const main = Effect.fn(function* () {
  const options = yield* native(parseOptions);
  if (!options) return 0;
  const library = yield* Effect.acquireRelease(native(loadHidapi), (library) =>
    Effect.sync(() => library.close()),
  );
  const api = yield* Effect.acquireRelease(Effect.succeed(library.symbols), (api) =>
    Effect.sync(() => {
      api.hid_exit();
    }),
  );
  yield* native(() => {
    if (api.hid_init() !== 0) throw new Error("hid_init failed");
  });
  yield* native(() => api.hid_darwin_set_open_exclusive(HID_OPEN_SHARED));
  const devices = yield* enumerateDevices(api, options.vendor, options.product);
  const path = choosePath(devices, options.productName);
  if (!path) {
    console.log(
      `logitech-platform: no matching Logitech device 0x${options.product.toString(16).padStart(4, "0")} is connected`,
    );
    return options.strict ? 1 : 0;
  }
  const handle = yield* Effect.acquireRelease(
    native(() => openDevice(api, path)),
    (handle) => Effect.sync(() => api.hid_close(handle)),
  );
  yield* setMultiplatform(nativeTransport(api, handle), options.platform, options.os);
  return 0;
});

if (import.meta.main)
  runMain(
    main().pipe(
      Effect.match({
        onSuccess: (code) => {
          process.exitCode = code;
        },
        onFailure: (error) => {
          console.error(`logitech-platform: ${error.message}`);
          process.exitCode = 1;
        },
      }),
    ),
  );
