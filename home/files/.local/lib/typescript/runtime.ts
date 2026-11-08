import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, Exit, Layer, Runtime, type Scope } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";

// Sibling deployed scripts resolve dependencies from this package, not the checkout
export {
  Config,
  Console,
  Data,
  Effect,
  FileSystem,
  Option,
  Schema,
  Stdio,
  Stream,
} from "effect";
export { HttpClient } from "effect/http";
export { ChildProcess, ChildProcessSpawner } from "effect/process";
export { exitCode } from "./process.ts";

export const layer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

// Share process cleanup and diagnostics without coupling callers' service layers
export function runMainWith<E>(
  program: Effect.Effect<unknown, E>,
  options?: { readonly teardown?: Runtime.Teardown },
): void {
  BunRuntime.runMain(
    program.pipe(
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

export function runMain<E>(
  program: Effect.Effect<
    unknown,
    E,
    BunServices.BunServices | HttpClient.HttpClient | Scope.Scope
  >,
): void {
  // Protocol entrypoints must never send runtime diagnostics to stdout
  runMainWith(program.pipe(Effect.scoped, Effect.provide(layer)), {
    teardown: (exit, onExit) =>
      Runtime.defaultTeardown(exit, (code) => {
        const preserveStatus =
          Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause);
        onExit(preserveStatus ? Number(process.exitCode ?? code) : code);
      }),
  });
}
