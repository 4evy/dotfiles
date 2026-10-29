import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

class NativeError extends Data.TaggedError("NativeError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

// GObject getters and methods can throw across the native FFI boundary
export function native<A>(operation: string, evaluate: () => A) {
  return Effect.try({
    try: evaluate,
    catch: (cause) => new NativeError({ operation, cause }),
  });
}
