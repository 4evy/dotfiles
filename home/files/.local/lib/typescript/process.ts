import { constants } from "node:os";
import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/process";

export function exitCode(
  child: Pick<ChildProcessSpawner.ChildProcessHandle, "exitCode">,
) {
  return child.exitCode.pipe(
    Effect.catchTag("PlatformError", (error) => {
      // The platform exposes signal termination only through its native cause
      // Preserve shell status codes without replacing its scoped process service
      const cause = error.reason.cause;
      const signal =
        error.reason.method === "exitCode" && cause instanceof Error
          ? /^Process interrupted due to receipt of signal: '(SIG[A-Z0-9]+)'$/.exec(
              cause.message,
            )?.[1]
          : undefined;
      const number =
        signal && Object.hasOwn(constants.signals, signal)
          ? constants.signals[signal as keyof typeof constants.signals]
          : undefined;
      return number === undefined ? Effect.fail(error) : Effect.succeed(128 + number);
    }),
  );
}
