import { isIP } from "node:net";
import { parseArgs } from "node:util";
import { UsageError } from "@dotfiles/core/errors";
import { Effect, Schema, SchemaTransformation } from "effect";
import defaults from "./defaults.json";

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
const ip = Schema.String.check(
  Schema.makeFilter((value: string) => {
    try {
      normalizeIP(value);
      return true;
    } catch {
      return "Invalid IP address";
    }
  }),
).pipe(
  Schema.decode(
    SchemaTransformation.transform({
      decode: normalizeIP,
      encode: (value: string) => value,
    }),
  ),
);
const optionalDriver = Schema.NullOr(Schema.String).pipe(
  Schema.decode(
    SchemaTransformation.transform({
      decode: (value: string | null) => value || null,
      encode: (value: string | null) => value,
    }),
  ),
);
const truthy: Record<string, true> = {
  "1": true,
  on: true,
  true: true,
  yes: true,
  t: true,
  y: true,
};
const falsy: Record<string, true> = {
  "0": true,
  off: true,
  false: true,
  no: true,
  f: true,
  n: true,
};
const boolean = Schema.Union([Schema.Boolean, Schema.String])
  .check(
    Schema.makeFilter(
      (value) =>
        typeof value === "boolean" ||
        Object.hasOwn(truthy, value.toLowerCase()) ||
        Object.hasOwn(falsy, value.toLowerCase()),
      { message: "Invalid boolean" },
    ),
  )
  .pipe(
    Schema.decodeTo(
      Schema.Boolean,
      SchemaTransformation.transform({
        decode: (value: boolean | string) =>
          typeof value === "boolean"
            ? value
            : Object.hasOwn(truthy, value.toLowerCase()),
        encode: (value: boolean): boolean | string => value,
      }),
    ),
  );
export const portNumberSchema = Schema.Union([
  Schema.Number,
  Schema.NumberFromString,
]).check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 }));
const phoneOptions = {
  name: {
    field: "name",
    type: "string",
    argument: "HOST",
    environment: "PHONE_MIRROR_NAME",
    schema: Schema.NonEmptyString.pipe(
      Schema.withDecodingDefault(Effect.succeed(defaults.name)),
    ),
  },
  ip: {
    field: "ip",
    type: "string",
    argument: "ADDRESS",
    environment: "PHONE_MIRROR_IP",
    schema: Schema.NullOr(ip).pipe(
      Schema.withDecodingDefault(Effect.succeed(defaults.ip)),
    ),
  },
  port: {
    field: "port",
    type: "string",
    argument: "PORT",
    environment: "PHONE_MIRROR_PORT",
    schema: portNumberSchema.pipe(
      Schema.withDecodingDefault(Effect.succeed(defaults.port)),
    ),
  },
  "connect-only": {
    field: "connectOnly",
    type: "boolean",
    argument: "",
    environment: "PHONE_MIRROR_CONNECT_ONLY",
    schema: boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(defaults.connectOnly)),
    ),
  },
  "render-driver": {
    field: "renderDriver",
    type: "string",
    argument: "DRIVER",
    environment: "PHONE_MIRROR_RENDER_DRIVER",
    schema: optionalDriver.pipe(
      Schema.withDecodingDefault(Effect.succeed(defaults.renderDriver)),
    ),
  },
  "sdl-video-driver": {
    field: "sdlVideoDriver",
    type: "string",
    argument: "DRIVER",
    environment: "PHONE_MIRROR_SDL_VIDEODRIVER",
    schema: optionalDriver.pipe(
      Schema.withDecodingDefault(Effect.succeed(defaults.sdlVideoDriver)),
    ),
  },
} as const;
const options = Object.entries(phoneOptions);
export const phoneUsage = `${options
  .map(([name, option]) => `[--${name}${option.argument ? ` ${option.argument}` : ""}]`)
  .join(" ")} [-- SCRCPY_ARGUMENTS...]`;
export const phoneEnvironment = options.map(([, option]) => option.environment);
const configSchema = Schema.Struct({
  ...(Object.fromEntries(
    options.map(([, option]) => [option.field, option.schema]),
  ) as {
    [K in keyof typeof phoneOptions as (typeof phoneOptions)[K]["field"]]: (typeof phoneOptions)[K]["schema"];
  }),
  scrcpyArgs: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type PhoneConfig = Readonly<typeof configSchema.Type>;
export const targetCacheSchema = Schema.Struct({ name: Schema.String, ip });
export const phoneConfig = Effect.fn("phoneConfig")(function* (args: string[]) {
  const known = Object.fromEntries(
    options.map(([name, option]) => [name, { type: option.type }]),
  );
  const { values, tokens } = yield* Effect.try({
    try: () =>
      parseArgs({
        args,
        options: known,
        strict: false,
        allowPositionals: true,
        tokens: true,
      }),
    catch: (error) =>
      new UsageError(
        `Invalid phone-mirror configuration: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  const indexes = new Set<number>();
  for (const token of tokens)
    if (
      token.kind === "positional" ||
      (token.kind === "option" && !(token.name in known))
    )
      indexes.add(token.index);
  const input = yield* Effect.sync(() => ({
    ...Object.fromEntries(
      options.map(([name, option]) => [
        option.field,
        values[name] ?? process.env[option.environment],
      ]),
    ),
    scrcpyArgs: [...indexes]
      .map((index) => args[index])
      .filter((value): value is string => value !== undefined && value !== "--"),
  }));
  const config = yield* Schema.decodeUnknownEffect(configSchema)(input).pipe(
    Effect.mapError(
      (error) => new UsageError(`Invalid phone-mirror configuration: ${error.message}`),
    ),
  );
  return Object.freeze(config);
});
