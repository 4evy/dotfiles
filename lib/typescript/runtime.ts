import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, Layer, type Runtime, type Scope } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";

export type RuntimeServices = BunServices.BunServices | HttpClient.HttpClient;

export const layer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

// One scope and signal-aware main fiber own the program's platform resources
export function runMain<E>(
  program: Effect.Effect<unknown, E, RuntimeServices | Scope.Scope>,
  options?: { readonly teardown?: Runtime.Teardown },
): void {
  BunRuntime.runMain(
    program.pipe(
      Effect.scoped,
      Effect.provide(layer),
      // Stdio borrows stdin, the CLI owner closes any pending native read
      Effect.ensuring(Effect.sync(() => process.stdin.destroy())),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Console.error(Cause.pretty(cause)),
      ),
    ),
    { ...options, disableErrorReporting: true },
  );
}
