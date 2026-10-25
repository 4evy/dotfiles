import { isIP } from "node:net";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { UsageError } from "../../../../lib/typescript/errors.ts";

export function normalizeIP(value: string): string {
  const [address = "", scope] = value.split("%");
  const version = isIP(address);
  if (
    !version ||
    (scope !== undefined && (version !== 6 || !scope || value.split("%").length !== 2))
  )
    throw new UsageError("Invalid IP address");
  if (version === 4) return address;
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  return `${canonical}${scope === undefined ? "" : `%${scope}`}`;
}
const objectInput = v.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
const ip = v.pipe(
  v.string(),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    try {
      return normalizeIP(dataset.value);
    } catch {
      addIssue({ message: "Invalid IP address" });
      return NEVER;
    }
  }),
);
const optionalDriver = v.pipe(
  v.nullable(v.string()),
  v.transform((value) => value || null),
);
const boolean = v.pipe(
  v.unknown(),
  v.parseBoolean({
    truthy: [true, "1", "on", "true", "yes", "t", "y"],
    falsy: [false, "0", "off", "false", "no", "f", "n"],
  }),
);
const configSchema = v.pipe(
  objectInput,
  v.object({
    name: v.optional(v.pipe(v.string(), v.minLength(1)), "samsung-s25"),
    ip: v.optional(v.nullable(ip), null),
    port: v.optional(
      v.pipe(
        v.unknown(),
        v.toNumber(),
        v.safeInteger(),
        v.minValue(1),
        v.maxValue(65535),
      ),
      5555,
    ),
    connectOnly: v.optional(boolean, false),
    renderDriver: v.optional(optionalDriver, "software"),
    sdlVideoDriver: v.optional(optionalDriver, "x11"),
    scrcpyArgs: v.optional(v.array(v.string()), () => []),
  }),
  v.transform((value) => Object.freeze(value)),
);
export type PhoneConfig = v.InferOutput<typeof configSchema>;
export const targetCacheSchema = v.pipe(
  objectInput,
  v.object({ name: v.string(), ip }),
);

export function phoneConfig(args: string[]): PhoneConfig {
  const known = {
    name: { type: "string" },
    ip: { type: "string" },
    port: { type: "string" },
    "connect-only": { type: "boolean" },
    "render-driver": { type: "string" },
    "sdl-video-driver": { type: "string" },
  } as const;
  const { values, tokens } = parseArgs({
    args,
    options: known,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const indexes = new Set<number>();
  for (const token of tokens)
    if (
      token.kind === "positional" ||
      (token.kind === "option" && !(token.name in known))
    )
      indexes.add(token.index);
  const parsed = v.safeParse(configSchema, {
    name: values.name ?? process.env.PHONE_MIRROR_NAME,
    ip: values.ip ?? process.env.PHONE_MIRROR_IP,
    port: values.port ?? process.env.PHONE_MIRROR_PORT,
    connectOnly: values["connect-only"] ?? process.env.PHONE_MIRROR_CONNECT_ONLY,
    renderDriver: values["render-driver"] ?? process.env.PHONE_MIRROR_RENDER_DRIVER,
    sdlVideoDriver:
      values["sdl-video-driver"] ?? process.env.PHONE_MIRROR_SDL_VIDEODRIVER,
    scrcpyArgs: [...indexes]
      .map((index) => args[index])
      .filter((value): value is string => value !== undefined && value !== "--"),
  });
  if (!parsed.success)
    throw new UsageError(
      `Invalid phone-mirror configuration: ${parsed.issues.map((issue) => `${v.getDotPath(issue) ?? ""}: ${issue.message}`).join("; ")}`,
    );
  return parsed.output;
}
