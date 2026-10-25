import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";
import * as v from "valibot";
import type { CommandResult } from "../../../../lib/typescript/commands.ts";
import {
  execProcess,
  requireCommands,
  run,
} from "../../../../lib/typescript/commands.ts";
import { DotfilesError } from "../../../../lib/typescript/errors.ts";
import { ensureDirectory, writeJson } from "../../../../lib/typescript/files.ts";
import { cachePath } from "../../../../lib/typescript/paths.ts";
import type { PhoneConfig } from "./config.ts";
import { normalizeIP, phoneConfig, targetCacheSchema } from "./config.ts";

type RunCommand = (args: string[], options: { timeout: number }) => CommandResult;
const command: RunCommand = (args, options) =>
  run(args, { ...options, capture: true, check: false });
const guiKeys = new Set([
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
]);

function detail(result: CommandResult): string {
  return (
    (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).at(-1) ||
    "unknown error"
  );
}
function resolveTailscaleIP(name: string, execute: RunCommand): string {
  const result = execute(["tailscale", "ip", "--", name], { timeout: 8 });
  if (result.code !== 0)
    throw new DotfilesError(`Tailscale IP lookup failed: ${detail(result)}`);
  let addresses: string[];
  try {
    addresses = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(normalizeIP);
  } catch {
    throw new DotfilesError("Tailscale IP lookup returned invalid data");
  }
  const address = addresses.find((value) => isIP(value) === 4) ?? addresses[0];
  if (!address)
    throw new DotfilesError(`Tailscale did not report a valid IP for ${name}`);
  return address;
}
function cacheFile(name: string): string {
  const safeName =
    name.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "phone";
  return cachePath("phone-mirror", `${safeName}.json`);
}
function cachedIP(path: string, name: string): string | undefined {
  try {
    const parsed = v.safeParse(
      targetCacheSchema,
      JSON.parse(readFileSync(path, "utf8")),
    );
    return parsed.success && parsed.output.name === name ? parsed.output.ip : undefined;
  } catch {
    return undefined;
  }
}
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
const objectInput = v.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
const portSchema = v.pipe(
  objectInput,
  v.object({
    protocol: v.optional(v.string()),
    portid: v.optional(v.union([v.string(), v.pipe(v.number(), v.finite())])),
    state: v.optional(v.pipe(objectInput, v.object({ state: v.optional(v.string()) }))),
  }),
);
const scanSchema = v.pipe(
  objectInput,
  v.object({
    nmaprun: v.optional(
      v.pipe(
        objectInput,
        v.object({
          host: v.optional(
            v.array(
              v.pipe(
                objectInput,
                v.object({
                  ports: v.optional(
                    v.pipe(
                      objectInput,
                      v.object({ port: v.optional(v.array(portSchema)) }),
                    ),
                  ),
                }),
              ),
            ),
          ),
        }),
      ),
    ),
  }),
);
const portNumberSchema = v.pipe(
  v.unknown(),
  v.toNumber(),
  v.safeInteger(),
  v.minValue(1),
  v.maxValue(65535),
);
function openPorts(xml: string): number[] {
  try {
    new SyntaxValidator().validate(xml);
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      processEntities: false,
      isArray: (_name, path) =>
        ["nmaprun.host", "nmaprun.host.ports.port"].includes(path.toString()),
    });
    const scan = v.parse(scanSchema, parser.parse(xml));
    const ports = new Set<number>();
    for (const host of scan.nmaprun?.host ?? [])
      for (const port of host.ports?.port ?? [])
        if (port.protocol === "tcp" && port.state?.state === "open")
          ports.add(v.parse(portNumberSchema, port.portid));
    return [...ports];
  } catch {
    throw new DotfilesError("Invalid Nmap scan output");
  }
}
function scanOpenPorts(host: string, execute: RunCommand): number[] {
  const result = execute(
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
    throw new DotfilesError(`Nmap port discovery failed: ${detail(result)}`);
  return openPorts(result.stdout);
}

class PhoneMirror {
  readonly #config: PhoneConfig;
  readonly #execute: RunCommand;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #cache: string;
  constructor(config: PhoneConfig, execute: RunCommand = command) {
    this.#config = config;
    this.#execute = execute;
    this.#environment = { ...process.env };
    this.#cache = cacheFile(config.name);
  }
  #adb(args: string[], timeout = 10): CommandResult {
    return this.#execute(["adb", ...args], { timeout });
  }
  #devices(): Map<string, string> {
    const result = this.#adb(["devices", "-l"]);
    if (result.code !== 0)
      throw new DotfilesError(`ADB devices failed: ${detail(result)}`);
    return parseDevices(result.stdout);
  }
  #connect(host: string, port: number): string | undefined {
    const serial = endpoint(host, port);
    console.error(`phone-mirror: trying ${serial}`);
    this.#adb(["connect", serial]);
    if (this.#devices().get(serial) === "device") return serial;
    this.#adb(["disconnect", serial], 5);
    return undefined;
  }
  async #makeStable(serial: string, host: string): Promise<string> {
    const stable = endpoint(host, this.#config.port);
    if (serial === stable) return serial;
    console.error(`phone-mirror: moving ADB from ${serial} to ${stable}`);
    const result = this.#adb(["-s", serial, "tcpip", String(this.#config.port)], 15);
    if (result.code !== 0)
      throw new DotfilesError(`Could not enable stable ADB: ${detail(result)}`);
    for (let attempt = 0; attempt < 12; attempt++) {
      await Bun.sleep(250);
      const connected = this.#connect(host, this.#config.port);
      if (connected) return connected;
    }
    throw new DotfilesError(`Could not reconnect to ${stable} after enabling ADB`);
  }
  async #connectPhone(host: string): Promise<string> {
    const started = this.#adb(["start-server"], 15);
    if (started.code !== 0)
      throw new DotfilesError(`Could not start ADB: ${detail(started)}`);
    const target = [...this.#devices()]
      .filter(([serial, state]) => state === "device" && serialHost(serial) === host)
      .map(([serial]) => serial);
    if (target.length)
      return this.#makeStable(
        target.includes(endpoint(host, this.#config.port))
          ? endpoint(host, this.#config.port)
          : (target[0] ?? ""),
        host,
      );
    const connected = this.#connect(host, this.#config.port);
    if (connected) return connected;
    // One USB or LAN session can bootstrap the stable Tailscale endpoint
    const online = [...this.#devices()]
      .filter(([, state]) => state === "device")
      .map(([serial]) => serial);
    if (online.length === 1) return this.#makeStable(online[0] ?? "", host);
    return this.#discover(host, online.length);
  }
  async #discover(host: string, online: number): Promise<string> {
    requireCommands("nmap");
    console.error("phone-mirror: probing Wireless Debugging ports 30000-49999");
    for (const port of scanOpenPorts(host, this.#execute)) {
      const connected = this.#connect(host, port);
      if (connected) return this.#makeStable(connected, host);
    }
    if (online > 1)
      throw new DotfilesError(
        "More than one ADB device is connected and none matches the target",
      );
    throw new DotfilesError(
      "Could not reach ADB; enable Wireless debugging or connect the phone over USB, then retry",
    );
  }
  #preferLAN(serial: string): string {
    const result = this.#adb([
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
    const networks = localIPv4Networks();
    for (const address of phoneLANAddresses(result.stdout)) {
      if (
        !networks.some(
          ({ network, mask }) => (ipv4Number(address) & mask) >>> 0 === network,
        )
      )
        continue;
      const connected = this.#connect(address, this.#config.port);
      if (connected) {
        console.error(`phone-mirror: using local network address ${address}`);
        return connected;
      }
    }
    return serial;
  }
  #targetIP(): string {
    if (this.#config.ip) return this.#config.ip;
    let host: string;
    try {
      host = resolveTailscaleIP(this.#config.name, this.#execute);
    } catch (error) {
      if (!(error instanceof DotfilesError)) throw error;
      const cached = cachedIP(this.#cache, this.#config.name);
      if (!cached) throw error;
      console.error(`phone-mirror: using cached Tailscale address ${cached}`);
      return cached;
    }
    ensureDirectory(dirname(this.#cache), 0o700);
    writeJson(this.#cache, { name: this.#config.name, ip: host }, 0o600);
    return host;
  }
  #hydrateGUIEnvironment(): void {
    if (process.platform !== "linux") return;
    const runtime = `/run/user/${process.getuid?.()}`;
    if (!this.#environment.XDG_RUNTIME_DIR && existsSync(runtime))
      this.#environment.XDG_RUNTIME_DIR = runtime;
    if (!Bun.which("systemctl")) return;
    const result = this.#execute(["systemctl", "--user", "show-environment"], {
      timeout: 5,
    });
    if (result.code !== 0) return;
    for (const line of result.stdout.split(/\r?\n/)) {
      const equals = line.indexOf("=");
      if (equals < 0) continue;
      const key = line.slice(0, equals);
      if (guiKeys.has(key)) this.#environment[key] ??= line.slice(equals + 1);
    }
  }
  #scrcpyArguments(serial: string): string[] {
    const help = this.#execute(["scrcpy", "--help"], { timeout: 5 });
    const active = (help.stdout + help.stderr).includes("--keep-active")
      ? "--keep-active"
      : "--stay-awake";
    const args = [
      `--serial=${serial}`,
      active,
      "--video-codec=h265",
      "--video-bit-rate=2M",
      "--max-size=1280",
      "--max-fps=30",
    ];
    if (process.platform === "linux" && this.#config.renderDriver)
      args.push("--render-driver", this.#config.renderDriver);
    return [...args, ...this.#config.scrcpyArgs];
  }
  async run(): Promise<void> {
    requireCommands("adb");
    const host = this.#targetIP();
    let serial = await this.#connectPhone(host);
    if (this.#config.connectOnly) {
      console.error(`phone-mirror: connected to ${serial}`);
      return;
    }
    serial = this.#preferLAN(serial);
    requireCommands("scrcpy");
    this.#hydrateGUIEnvironment();
    if (
      process.platform === "linux" &&
      !this.#environment.WAYLAND_DISPLAY &&
      !this.#environment.DISPLAY
    )
      throw new DotfilesError(
        "No graphical Linux session found; run from the desktop or export DISPLAY/WAYLAND_DISPLAY",
      );
    if (process.platform === "linux" && this.#config.sdlVideoDriver)
      this.#environment.SDL_VIDEODRIVER ??= this.#config.sdlVideoDriver;
    execProcess("scrcpy", this.#scrcpyArguments(serial), this.#environment, "scrcpy");
  }
}

export async function phoneMirror(args: string[]): Promise<void> {
  await new PhoneMirror(phoneConfig(args)).run();
}
