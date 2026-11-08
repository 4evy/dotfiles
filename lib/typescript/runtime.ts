import { runMainWith } from "@dotfiles/runtime/runtime";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, type Runtime, type Scope } from "effect";
import { SecureRandom } from "effect/crypto";
import { FetchHttpClient, type HttpClient } from "effect/http";

export type RuntimeServices =
  | BunServices.BunServices
  | HttpClient.HttpClient
  | SecureRandom.SecureRandom;

// Effect 4.1 separates secure randomness from the platform's BunServices
export const layer = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  SecureRandom.layerWebCrypto,
);

// One scope and signal-aware main fiber own the program's platform resources
export function runMain<E>(
  program: Effect.Effect<unknown, E, RuntimeServices | Scope.Scope>,
  options?: { readonly teardown?: Runtime.Teardown },
): void {
  runMainWith(program.pipe(Effect.scoped, Effect.provide(layer)), options);
}
