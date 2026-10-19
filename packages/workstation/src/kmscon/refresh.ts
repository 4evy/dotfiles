import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { output, run } from "../../../../lib/typescript/commands.ts";
import { UsageError } from "../../../../lib/typescript/errors.ts";
import { writeIfChanged } from "../../../../lib/typescript/files.ts";

const ttys = new Set(Array.from({ length: 6 }, (_, index) => `tty${index + 1}`));
const stateSchema = v.pipe(
  v.custom<Record<string, unknown>>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  ),
  v.object({
    config_sha256: v.string(),
    pending_ttys: v.array(v.string()),
  }),
);

function occupiedTtys(): Set<string> {
  const occupied = new Set<string>();
  const sessions = v.parse(
    v.array(v.object({ tty: v.string(), vtNr: v.number() })),
    JSON.parse(output(["farstep-desktop", "systemd", "sessions"])),
  );
  for (const session of sessions) {
    const tty = ttys.has(session.tty) ? session.tty : `tty${session.vtNr}`;
    if (tty && ttys.has(tty)) occupied.add(tty);
  }
  return occupied;
}

function pendingTtys(state: string, digest: string): Set<string> {
  try {
    const parsed = v.safeParse(stateSchema, JSON.parse(readFileSync(state, "utf8")));
    if (parsed.success && parsed.output.config_sha256 === digest)
      return new Set(parsed.output.pending_ttys.filter((tty) => ttys.has(tty)));
  } catch {
    /* A missing or corrupt state means every console needs this config */
  }
  return new Set(ttys);
}

export function kmsconRefresh(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { state: { type: "string", default: "/run/kmscon-theme-refresh.json" } },
  });
  const [config] = positionals;
  if (positionals.length !== 1 || !config)
    throw new UsageError("Usage: kmscon-refresh CONFIG [--state PATH]");
  const digest = createHash("sha256").update(readFileSync(config)).digest("hex");
  const pending = pendingTtys(values.state, digest);
  if (!pending.size) return 0;
  const occupied = occupiedTtys();
  const remaining = new Set<string>();
  let failed = false;
  for (const tty of [...pending].sort()) {
    if (occupied.has(tty)) {
      remaining.add(tty);
      continue;
    }
    if (
      run(["farstep-desktop", "systemd", "try", "restart", `kmsconvt@${tty}.service`], {
        check: false,
      }).code !== 0
    ) {
      remaining.add(tty);
      failed = true;
    }
  }
  writeIfChanged(
    values.state,
    `${JSON.stringify({ config_sha256: digest, pending_ttys: [...remaining].sort() }, null, 2)}\n`,
  );
  return failed ? 1 : 0;
}
