import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";
import type { CommandResult } from "@dotfiles/core/commands";
import { requireCommands, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { ensureDirectory, writeJson } from "@dotfiles/core/files";
import { cachePath } from "@dotfiles/core/paths";
import { Console, Effect, FileSystem, Schema } from "effect";
import { XMLParser } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";
import type { PhoneConfig } from "./config.ts";
import {
  normalizeIP,
  phoneConfig,
  portNumberSchema,
  targetCacheSchema,
} from "./config.ts";
import defaults from "./defaults.json";

const command = (args: string[], options: { timeout: number }) =>
  run(args, { ...options, capture: true, check: false });
const guiKeys: Record<string, true> = {
  DBUS_SESSION_BUS_ADDRESS: true,
  DISPLAY: true,
  WAYLAND_DISPLAY: true,
  XAUTHORITY: true,
  XDG_CURRENT_DESKTOP: true,
  XDG_SESSION_TYPE: true,
};

function detail(result: CommandResult): string {
  return (
    (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).at(-1) ||
    "unknown error"
  );
}
const resolveTailscaleIP = Effect.fn("resolveTailscaleIP")(function* (name: string) {
  const result = yield* command(["tailscale", "ip", "--", name], { timeout: 8 });
  if (result.code !== 0)
    return yield* Effect.fail(
      new DotfilesError(`Tailscale IP lookup failed: ${detail(result)}`),
    );
  const addresses = yield* Effect.try({
    try: () => result.stdout.trim().split(/\r?\n/).filter(Boolean).map(normalizeIP),
    catch: () => new DotfilesError("Tailscale IP lookup returned invalid data"),
  });
  const address = addresses.find((value) => isIP(value) === 4) ?? addresses[0];
  if (!address)
    return yield* Effect.fail(
      new DotfilesError(`Tailscale did not report a valid IP for ${name}`),
    );
  return address;
});
function cacheFile(name: string) {
  const safeName =
    name.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "phone";
  return cachePath("phone-mirror", `${safeName}.json`);
}
const cachedIP = Effect.fn("cachedPhoneIP")(function* (path: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(targetCacheSchema)),
    ),
    Effect.map((cached) => (cached.name === name ? cached.ip : undefined)),
    Effect.catch(() => Effect.succeed(undefined)),
  );
});
function endpoint(host: string, port: number): string {
  return isIP(host.split("%")[0] ?? "") === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}
function serialHost(serial: string): string | undefined {
  const colon = serial.startsWith("[") ? serial.indexOf("]:") : serial.lastIndexOf(":");
  if (colon < 0) return undefined;
  try {
    return normalizeIP(serial.slice(serial.startsWith("[") ? 1 : 0, colon));
  } catch {
    return undefined;
  }
}
function parseDevices(text: string): Map<string, string> {
  const devices = new Map<string, string>();
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state) devices.set(serial, state);
  }
  return devices;
}
function ipv4Number(ip: string): number {
  return ip
    .split(".")
    .reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}
function localIPv4Networks(): { network: number; mask: number }[] {
  const networks = new Map<string, { network: number; mask: number }>();
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4") continue;
      const ip = ipv4Number(address.address);
      if (ip >>> 24 === 127 || ip >>> 16 === 0xa9fe) continue;
      const mask = ipv4Number(address.netmask);
      const network = (ip & mask) >>> 0;
      networks.set(`${network}/${mask}`, { network, mask });
    }
  return [...networks.values()];
}
function phoneLANAddresses(text: string): string[] {
  const addresses = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || !/^(?:eth|wlan)/.test(fields[1] ?? "")) continue;
    const inet = fields.indexOf("inet");
    const address = inet < 0 ? undefined : fields[inet + 1]?.split("/")[0];
    if (address && isIP(address) === 4) addresses.add(address);
  }
  return [...addresses];
}
const portSchema = Schema.Struct({
  protocol: Schema.optionalKey(Schema.String),
  portid: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Number.check(Schema.isFinite())]),
  ),
  state: Schema.optionalKey(
    Schema.Struct({ state: Schema.optionalKey(Schema.String) }),
  ),
});
const scanSchema = Schema.Struct({
  nmaprun: Schema.optionalKey(
    Schema.Struct({
      host: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            ports: Schema.optionalKey(
              Schema.Struct({ port: Schema.optionalKey(Schema.Array(portSchema)) }),
            ),
          }),
        ),
      ),
    }),
  ),
});
const openPorts = Effect.fn("openPhonePorts")(function* (xml: string) {
  const parsed = yield* Effect.try({
    try: (): unknown => {
      new SyntaxValidator().validate(xml);
      return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
        processEntities: false,
        isArray: (_name, path) =>
          ["nmaprun.host", "nmaprun.host.ports.port"].includes(path.toString()),
      }).parse(xml);
    },
    catch: () => new DotfilesError("Invalid Nmap scan output"),
  });
  const scan = yield* Schema.decodeUnknownEffect(scanSchema)(parsed).pipe(
    Effect.mapError(() => new DotfilesError("Invalid Nmap scan output")),
  );
  const ports = new Set<number>();
  for (const host of scan.nmaprun?.host ?? [])
    for (const port of host.ports?.port ?? [])
      if (port.protocol === "tcp" && port.state?.state === "open")
        ports.add(
          yield* Schema.decodeUnknownEffect(portNumberSchema)(port.portid).pipe(
            Effect.mapError(() => new DotfilesError("Invalid Nmap scan output")),
          ),
        );
  return [...ports];
});
const scanOpenPorts = Effect.fn("scanPhonePorts")(function* (host: string) {
  const result = yield* command(
    [
      "nmap",
      "-Pn",
      "-n",
      "--open",
      "-T4",
      "--host-timeout",
      "45s",
      "-p",
      "30000-49999",
      "-oX",
      "-",
      host,
    ],
    { timeout: 50 },
  );
  if (result.code !== 0)
    return yield* Effect.fail(
      new DotfilesError(`Nmap port discovery failed: ${detail(result)}`),
    );
  return yield* openPorts(result.stdout);
});

const adb = (args: string[], timeout = 10) => command(["adb", ...args], { timeout });

const devices = Effect.fn("phoneDevices")(function* () {
  const result = yield* adb(["devices", "-l"]);
  if (result.code !== 0)
    return yield* Effect.fail(
      new DotfilesError(`ADB devices failed: ${detail(result)}`),
    );
  return parseDevices(result.stdout);
});

const connect = Effect.fn("connectPhoneEndpoint")(function* (
  host: string,
  port: number,
) {
  const serial = endpoint(host, port);
  yield* Console.error(`phone-mirror: trying ${serial}`);
  yield* adb(["connect", serial]);
  if ((yield* devices()).get(serial) === "device") return serial;
  yield* adb(["disconnect", serial], 5);
  return undefined;
});

const makeStable = Effect.fn("stabilizePhoneConnection")(function* (
  config: PhoneConfig,
  serial: string,
  host: string,
) {
  const stable = endpoint(host, config.port);
  if (serial === stable) return serial;
  yield* Console.error(`phone-mirror: moving ADB from ${serial} to ${stable}`);
  const result = yield* adb(["-s", serial, "tcpip", String(config.port)], 15);
  if (result.code !== 0)
    return yield* Effect.fail(
      new DotfilesError(`Could not enable stable ADB: ${detail(result)}`),
    );
  for (let attempt = 0; attempt < 12; attempt++) {
    yield* Effect.sleep("250 millis");
    const connected = yield* connect(host, config.port);
    if (connected) return connected;
  }
  return yield* Effect.fail(
    new DotfilesError(`Could not reconnect to ${stable} after enabling ADB`),
  );
});

const discover = Effect.fn("discoverPhone")(function* (
  config: PhoneConfig,
  host: string,
  online: number,
) {
  yield* requireCommands("nmap");
  yield* Console.error("phone-mirror: probing Wireless Debugging ports 30000-49999");
  for (const port of yield* scanOpenPorts(host)) {
    const connected = yield* connect(host, port);
    if (connected) return yield* makeStable(config, connected, host);
  }
  return yield* Effect.fail(
    new DotfilesError(
      online > 1
        ? "More than one ADB device is connected and none matches the target"
        : "Could not reach ADB; enable Wireless debugging or connect the phone over USB, then retry",
    ),
  );
});

const connectPhone = Effect.fn("connectPhone")(function* (
  config: PhoneConfig,
  host: string,
) {
  const started = yield* adb(["start-server"], 15);
  if (started.code !== 0)
    return yield* Effect.fail(
      new DotfilesError(`Could not start ADB: ${detail(started)}`),
    );
  const target = [...(yield* devices())]
    .filter(([serial, state]) => state === "device" && serialHost(serial) === host)
    .map(([serial]) => serial);
  if (target.length)
    return yield* makeStable(
      config,
      target.includes(endpoint(host, config.port))
        ? endpoint(host, config.port)
        : (target[0] ?? ""),
      host,
    );
  const connected = yield* connect(host, config.port);
  if (connected) return connected;
  // One USB or LAN session can bootstrap the stable Tailscale endpoint
  const online = [...(yield* devices())]
    .filter(([, state]) => state === "device")
    .map(([serial]) => serial);
  if (online.length === 1) return yield* makeStable(config, online[0] ?? "", host);
  return yield* discover(config, host, online.length);
});

const preferLAN = Effect.fn("preferPhoneLAN")(function* (
  config: PhoneConfig,
  serial: string,
) {
  const result = yield* adb([
    "-s",
    serial,
    "shell",
    "ip",
    "-o",
    "-4",
    "addr",
    "show",
    "up",
    "scope",
    "global",
  ]);
  if (result.code !== 0) return serial;
  const networks = yield* Effect.try({
    try: localIPv4Networks,
    catch: (error) =>
      new DotfilesError(
        `Could not inspect local networks: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  for (const address of phoneLANAddresses(result.stdout)) {
    if (
      !networks.some(
        ({ network, mask }) => (ipv4Number(address) & mask) >>> 0 === network,
      )
    )
      continue;
    const connected = yield* connect(address, config.port);
    if (connected) {
      yield* Console.error(`phone-mirror: using local network address ${address}`);
      return connected;
    }
  }
  return serial;
});

const targetIP = Effect.fn("phoneTargetIP")(function* (
  config: PhoneConfig,
  cache: string,
) {
  if (config.ip) return config.ip;
  const resolved = yield* resolveTailscaleIP(config.name).pipe(
    Effect.map((host) => ({ host, cached: false })),
    Effect.catch((error) =>
      Effect.gen(function* () {
        const host = yield* cachedIP(cache, config.name);
        if (!host) return yield* Effect.fail(error);
        yield* Console.error(`phone-mirror: using cached Tailscale address ${host}`);
        return { host, cached: true };
      }),
    ),
  );
  if (!resolved.cached) {
    yield* ensureDirectory(dirname(cache), 0o700);
    yield* writeJson(cache, { name: config.name, ip: resolved.host }, 0o600);
  }
  return resolved.host;
});

const hydrateGUIEnvironment = Effect.fn("phoneGUIEnvironment")(function* (
  environment: NodeJS.ProcessEnv,
) {
  if (process.platform !== "linux") return;
  const fs = yield* FileSystem.FileSystem;
  const runtime = `/run/user/${process.getuid?.()}`;
  if (
    !environment.XDG_RUNTIME_DIR &&
    (yield* fs.exists(runtime).pipe(Effect.catch(() => Effect.succeed(false))))
  )
    environment.XDG_RUNTIME_DIR = runtime;
  if (!(yield* requireCommands("systemctl").pipe(Effect.isSuccess))) return;
  const result = yield* command(["systemctl", "--user", "show-environment"], {
    timeout: 5,
  });
  if (result.code !== 0) return;
  for (const line of result.stdout.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals);
    if (Object.hasOwn(guiKeys, key)) environment[key] ??= line.slice(equals + 1);
  }
});

const scrcpyArguments = Effect.fn("phoneScrcpyArguments")(function* (
  config: PhoneConfig,
  serial: string,
) {
  const help = yield* command(["scrcpy", "--help"], { timeout: 5 });
  const active = (help.stdout + help.stderr).includes("--keep-active")
    ? "--keep-active"
    : "--stay-awake";
  const args = [`--serial=${serial}`, active, ...defaults.scrcpyArguments];
  if (process.platform === "linux" && config.renderDriver)
    args.push("--render-driver", config.renderDriver);
  return [...args, ...config.scrcpyArgs];
});

export const phoneMirror = Effect.fn("phoneMirror")(function* (args: string[]) {
  const config = yield* phoneConfig(args);
  const environment = yield* Effect.sync(() => ({ ...process.env }));
  const cache = yield* cacheFile(config.name);
  yield* requireCommands("adb");
  const host = yield* targetIP(config, cache);
  let serial = yield* connectPhone(config, host);
  if (config.connectOnly) {
    yield* Console.error(`phone-mirror: connected to ${serial}`);
    return 0;
  }
  serial = yield* preferLAN(config, serial);
  yield* requireCommands("scrcpy");
  yield* hydrateGUIEnvironment(environment);
  if (
    process.platform === "linux" &&
    !environment.WAYLAND_DISPLAY &&
    !environment.DISPLAY
  )
    return yield* Effect.fail(
      new DotfilesError(
        "No graphical Linux session found; run from the desktop or export DISPLAY/WAYLAND_DISPLAY",
      ),
    );
  if (process.platform === "linux" && config.sdlVideoDriver)
    environment.SDL_VIDEODRIVER ??= config.sdlVideoDriver;
  const result = yield* run(["scrcpy", ...(yield* scrcpyArguments(config, serial))], {
    env: environment,
    check: false,
  });
  return result.code;
});
