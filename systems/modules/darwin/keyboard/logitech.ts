#!/usr/bin/env bun
import { CString, dlopen, ptr, read } from "bun:ffi";
import { parseArgs } from "node:util";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect } from "effect";

// hidapi is a synchronous native ABI, kept behind narrow typed adapters
const native = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (cause) =>
      new DotfilesError(cause instanceof Error ? cause.message : String(cause)),
  });

const SOFTWARE_ID = 0x0b;
const MULTIPLATFORM = 0x4531;
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
  for (let offset = 0; ; offset += 4) {
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

export function choosePath(
  devices: Device[],
  productName?: string,
): string | undefined {
  const priority = new Map([
    [0xff43, 0],
    [0xff0c, 1],
    [0x0001, 2],
    [0x000c, 3],
  ]);
  return devices
    .filter((device) => !productName || device.product === productName)
    .sort(
      (left, right) =>
        (priority.get(left.usagePage) ?? 9) - (priority.get(right.usagePage) ?? 9),
    )[0]?.path;
}

export const request = Effect.fn(function* (
  transport: Transport,
  requestId: number,
  params = Buffer.alloc(0),
  timeoutMs = 4000,
) {
  requestId = (requestId & 0xfff0) | SOFTWARE_ID;
  const frame = Buffer.alloc(20);
  frame[0] = 0x11;
  frame[1] = 0xff;
  frame.writeUInt16BE(requestId, 2);
  params.copy(frame, 4, 0, 16);
  while ((yield* transport.read(0)).length) {
    /* Discard stale replies before sending */
  }
  yield* transport.write(frame);
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    // Bound native blocking so cancellation is observed between reads
    const data = yield* transport.read(
      Math.floor(Math.min(50, Math.max(1, deadline - performance.now()))),
    );
    if (data.length !== 20 || data[0] !== 0x11 || (data[1] !== 0xff && data[1] !== 0))
      continue;
    const payload = data.subarray(2);
    if (payload[0] === 0xff && payload.readUInt16BE(1) === requestId) {
      return yield* Effect.fail(
        new DotfilesError(
          `HID++ feature request 0x${requestId.toString(16).padStart(4, "0")} failed with error 0x${payload[3]?.toString(16).padStart(2, "0")}`,
        ),
      );
    }
    if (payload.readUInt16BE(0) === requestId) return payload.subarray(2);
  }
  return yield* Effect.fail(
    new DotfilesError(
      `timed out waiting for HID++ request 0x${requestId.toString(16).padStart(4, "0")}`,
    ),
  );
});

const featureIndex = Effect.fn(function* (transport: Transport, feature: number) {
  const parameter = Buffer.alloc(2);
  parameter.writeUInt16BE(feature);
  return (yield* request(transport, 0, parameter))[0] || undefined;
});

export function choosePlatform(
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
  const info = yield* request(transport, index << 8);
  if (info.length < 7)
    return yield* Effect.fail(
      new DotfilesError(
        `unexpected MULTIPLATFORM info payload: ${info.toString("hex")}`,
      ),
    );
  if (!((info[0] ?? 0) & 0x02)) {
    console.log("logitech-platform: keyboard reports MULTIPLATFORM as read-only");
    return false;
  }
  const descriptors: Descriptor[] = [];
  for (let descriptor = 0; descriptor < (info[2] ?? 0); descriptor++) {
    const reply = yield* request(
      transport,
      (index << 8) | 0x10,
      Buffer.from([descriptor]),
    );
    if (reply.length >= 8)
      descriptors.push({
        platform: reply.readUInt8(0),
        osFlags: reply.readUInt16BE(2),
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
    `logitech-platform: current=${info[6]} desired=${desired} descriptors=[${description}]`,
  );
  if (info[6] === desired) {
    console.log("logitech-platform: already configured");
    return false;
  }
  yield* request(transport, (index << 8) | 0x30, Buffer.from([0xff, desired]));
  const updated = yield* request(transport, index << 8);
  if (updated.length < 7 || updated[6] !== desired)
    return yield* Effect.fail(
      new DotfilesError(
        `MULTIPLATFORM write did not stick: ${updated.toString("hex")}`,
      ),
    );
  console.log("logitech-platform: updated current host platform");
  return true;
});

function integer(
  value: string | undefined,
  option: string,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0x[\da-f]+|\d+)$/i.test(value))
    throw new Error(`${option} must be an integer`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max)
    throw new Error(`${option} must be between 0 and ${max}`);
  return parsed;
}

function parseOptions() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "vendor-id": { type: "string", default: "0x046d" },
      "product-id": { type: "string" },
      "product-name": { type: "string" },
      platform: { type: "string" },
      os: { type: "string" },
      strict: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: bun logitech.ts --product-id ID [--product-name NAME] [--platform N | --os OS] [--strict]",
    );
    return undefined;
  }
  const vendor = integer(values["vendor-id"], "--vendor-id", 0xffff) ?? 0x046d;
  const product = integer(values["product-id"], "--product-id", 0xffff);
  if (product === undefined) throw new Error("--product-id is required");
  const platform = integer(values.platform, "--platform", 0xff);
  const os = values.os;
  if (os !== undefined && !Object.hasOwn(OS_BITS, os))
    throw new Error(`Unknown OS: ${os}`);
  return {
    vendor,
    product,
    productName: values["product-name"],
    platform,
    os: os as OsName | undefined,
    strict: values.strict,
  };
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
        // hid_device_info's pointer offsets follow the 64-bit Darwin C ABI
        // The appended bus_type field in hidapi 0.13 does not change them
        for (
          let current: number | bigint | null = head;
          current;
          current = read.ptr(current, 56)
        ) {
          const path = read.ptr(current, 0);
          if (path)
            devices.push({
              path: new CString(path).toString(),
              product: wideString(read.ptr(current, 40)),
              usagePage: read.u16(current, 48),
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
        const buffer = Buffer.alloc(32);
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
  yield* native(() => api.hid_darwin_set_open_exclusive(0));
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
