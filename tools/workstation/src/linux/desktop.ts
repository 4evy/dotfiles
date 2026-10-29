import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import source from "@dotfiles/workstation/assets/desktop" with { type: "text" };
import { Effect, Schema } from "effect";

export function desktopArguments(...args: string[]): [string, ...string[]] {
  return ["gjs", "-c", source, ...args];
}

export const desktopOutput = Effect.fn("desktopOutput")(function* (...args: string[]) {
  const result = yield* run(desktopArguments(...args), { capture: true, check: false });
  if (result.code !== 0)
    return yield* Effect.fail(
      new DotfilesError(`Desktop ${args[0]} failed: ${result.stderr.trim()}`),
    );
  return result.stdout.replace(/\n+$/, "");
});

const flatpakReferences = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      branch: Schema.String,
      arch: Schema.String,
      origin: Schema.NullOr(Schema.String),
      installation: Schema.String,
    }),
  ),
);

export const flatpakRefs = Effect.fn("flatpakRefs")(function* (
  kind: "apps" | "runtimes",
) {
  return yield* Schema.decodeUnknownEffect(flatpakReferences)(
    yield* desktopOutput(`flatpak-${kind}`),
  );
});
