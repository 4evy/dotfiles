import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";

class NativeError extends Data.TaggedError("NativeError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

// GJS owns the event loop, including during scope finalization
export const runNativeSync = Effect.runSyncWith(
  Context.make(Scheduler.PreventSchedulerYield, true),
);

// GObject getters and methods can throw across the native FFI boundary
export function native<A>(operation: string, evaluate: () => A) {
  return Effect.try({
    try: evaluate,
    catch: (cause) => new NativeError({ operation, cause }),
  });
}
