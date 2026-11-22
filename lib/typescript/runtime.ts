import { layer, runMainWith } from "@dotfiles/runtime/runtime";
import { Effect, type Layer, type Runtime, type Scope } from "effect";

export type RuntimeServices = Layer.Success<typeof layer>;

// One scope and signal-aware main fiber own the program's platform resources
export function runMain<E>(
  program: Effect.Effect<unknown, E, RuntimeServices | Scope.Scope>,
  options?: { readonly teardown?: Runtime.Teardown },
): void {
  runMainWith(program.pipe(Effect.scoped, Effect.provide(layer)), options);
}
