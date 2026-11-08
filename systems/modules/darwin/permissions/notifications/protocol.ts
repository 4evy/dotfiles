export type Action = "inspect" | "synchronize" | "apply" | "verify";
export type Grant = {
  requiresAuth: bigint;
  setFlags: bigint;
  clearFlags: bigint;
};
export type Input = {
  suite: string;
  container: string;
  identifiers: string[];
  grants: Grant[];
  baseline: string | undefined;
};

const uint64Max = (1n << 64n) - 1n;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a nonempty string without NUL characters`);
  }
  return value;
}

function mask(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be a decimal uint64 string`);
  }
  const result = BigInt(value);
  if (result > uint64Max) throw new Error(`${label} exceeds uint64`);
  return result;
}

export function parseInput(value: unknown, action: Action): Input {
  const input = object(value, "Input");
  if (!Array.isArray(input.identifiers) || !Array.isArray(input.grants)) {
    throw new Error("identifiers and grants must be arrays");
  }
  const identifiers = input.identifiers.map((value, index) =>
    string(value, `identifiers[${index}]`),
  );
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error("identifiers must be distinct");
  }
  const grants = input.grants.map((value, index) => {
    const grant = object(value, `grants[${index}]`);
    return {
      requiresAuth: mask(grant.requiresAuth, `grants[${index}].requiresAuth`),
      setFlags: mask(grant.setFlags, `grants[${index}].setFlags`),
      clearFlags: mask(grant.clearFlags, `grants[${index}].clearFlags`),
    };
  });
  const baseline =
    input.baseline === undefined ? undefined : string(input.baseline, "baseline");
  if (action === "verify" && baseline === undefined) {
    throw new Error("verify requires a baseline path");
  }
  return {
    suite: string(input.suite, "suite"),
    container: string(input.container, "container"),
    identifiers,
    grants,
    baseline,
  };
}

export function wantedFlags(
  app: { flags: bigint; auth: bigint },
  grants: Grant[],
): bigint {
  let flags = app.flags;
  for (const grant of grants) {
    if ((app.auth & grant.requiresAuth) === grant.requiresAuth) {
      flags = (flags | grant.setFlags) & ~grant.clearFlags & uint64Max;
    }
  }
  return flags;
}
