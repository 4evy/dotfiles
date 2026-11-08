import { createHash } from "node:crypto";
import { output, run } from "@dotfiles/core/commands";
import { UsageError } from "@dotfiles/core/errors";
import { writeJson } from "@dotfiles/core/files";
import { object } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { map, multiple } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { argument, option } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { Effect, FileSystem, Schema } from "effect";

const ttys = new Set(Array.from({ length: 6 }, (_, index) => `tty${index + 1}`));
const stateSchema = Schema.fromJsonString(
  Schema.Struct({
    config_sha256: Schema.String,
    pending_ttys: Schema.Array(Schema.String),
  }),
);
const sessionsSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ tty: Schema.String, vtNr: Schema.Number })),
);

const occupiedTtys = Effect.fn("kmsconRefresh.occupiedTtys")(function* () {
  const occupied = new Set<string>();
  const sessions = yield* Schema.decodeUnknownEffect(sessionsSchema)(
    yield* output(["farstep-desktop", "systemd", "sessions"]),
  );
  for (const session of sessions) {
    const tty = ttys.has(session.tty) ? session.tty : `tty${session.vtNr}`;
    if (tty && ttys.has(tty)) occupied.add(tty);
  }
  return occupied;
});

const pendingTtys = Effect.fn("kmsconRefresh.pendingTtys")(function* (
  state: string,
  digest: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // A missing or corrupt state means every console needs this config
  return yield* Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(stateSchema)(
      yield* fs.readFileString(state),
    );
    return parsed.config_sha256 === digest
      ? new Set(parsed.pending_ttys.filter((tty) => ttys.has(tty)))
      : new Set(ttys);
  }).pipe(Effect.catch(() => Effect.succeed(new Set(ttys))));
});

export const kmsconRefresh = Effect.fn("kmsconRefresh")(function* (args: string[]) {
  const fs = yield* FileSystem.FileSystem;
  const parsed = parseSync(
    object({
      config: argument(string({ metavar: "CONFIG", pattern: /./s })),
      state: map(
        multiple(option("--state", string({ metavar: "PATH" }))),
        (values) => values.at(-1) ?? "/run/kmscon-theme-refresh.json",
      ),
    }),
    args,
  );
  if (!parsed.success)
    return yield* Effect.fail(new UsageError(formatMessage(parsed.error)));
  const { config, state } = parsed.value;
  const digest = createHash("sha256")
    .update(yield* fs.readFile(config))
    .digest("hex");
  const pending = yield* pendingTtys(state, digest);
  if (!pending.size) return 0;
  const occupied = yield* occupiedTtys();
  const remaining = new Set<string>();
  let failed = false;
  for (const tty of [...pending].sort()) {
    if (occupied.has(tty)) {
      remaining.add(tty);
      continue;
    }
    if (
      (yield* run(
        ["farstep-desktop", "systemd", "try", "restart", `kmsconvt@${tty}.service`],
        { check: false },
      )).code !== 0
    ) {
      remaining.add(tty);
      failed = true;
    }
  }
  yield* writeJson(state, {
    config_sha256: digest,
    pending_ttys: [...remaining].sort(),
  });
  return failed ? 1 : 0;
});
