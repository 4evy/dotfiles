import { Schema, SchemaTransformation } from "effect";

export type Action = "inspect" | "synchronize" | "apply" | "verify";

const flagBits = 64;
const uint64Max = (1n << BigInt(flagBits)) - 1n;

const cString = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 && !value.includes("\0"), {
    message: "Expected a nonempty string without NUL characters",
  }),
);
const isCString = Schema.is(cString);
const mask = Schema.String.check(
  Schema.isPattern(/^\d+$/, { message: "Expected a decimal uint64 string" }),
).pipe(
  Schema.decodeTo(
    Schema.BigInt.check(
      Schema.isLessThanOrEqualToBigInt(uint64Max, { message: "Exceeds uint64" }),
    ),
    SchemaTransformation.bigintFromString,
  ),
);
const grantSchema = Schema.Struct({
  requiresAuth: mask,
  setFlags: mask,
  clearFlags: mask,
});
const inputSchema = Schema.Struct({
  suite: cString,
  container: cString,
  identifiers: Schema.UniqueArray(cString),
  grants: Schema.Array(grantSchema),
  baseline: Schema.optional(cString),
});

export type Input = typeof inputSchema.Type;

export function string(value: unknown, label: string): string {
  if (!isCString(value)) {
    throw new Error(`${label} must be a nonempty string without NUL characters`);
  }
  return value;
}

export function parseInput(value: unknown, action: Action): Input {
  const input = Schema.decodeUnknownSync(inputSchema)(value);
  if (action === "verify" && input.baseline === undefined) {
    throw new Error("verify requires a baseline path");
  }
  return input;
}

export function wantedFlags(
  app: { flags: bigint; auth: bigint },
  grants: Input["grants"],
): bigint {
  let flags = app.flags;
  for (const grant of grants) {
    if ((app.auth & grant.requiresAuth) === grant.requiresAuth) {
      flags = BigInt.asUintN(flagBits, (flags | grant.setFlags) & ~grant.clearFlags);
    }
  }
  return flags;
}
