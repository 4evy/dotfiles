import { DotfilesError } from "@dotfiles/core/errors";
import { Effect } from "effect";
import { ChildProcess } from "effect/process";
import type { Variables } from "./config.ts";

export function signalHandlers(handle: (signal: NodeJS.Signals) => void) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const handlers = new Map<NodeJS.Signals, () => void>();
      for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const) {
        const handler = () => handle(signal);
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
      return handlers;
    }),
    (handlers) =>
      Effect.sync(() => {
        for (const [signal, handler] of handlers)
          process.removeListener(signal, handler);
      }),
  );
}

function processError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new DotfilesError(message, {
    cause,
  });
}

export function spawn(
  command: string,
  args: string[],
  options: ChildProcess.CommandOptions,
) {
  return ChildProcess.make(command, args, options).pipe(
    Effect.catchDefect((cause) => Effect.fail(processError(cause))),
  );
}

export function replaceProcess(command: string, argv: string[], env: Variables) {
  return Effect.try({
    try: (): never => {
      process.execve?.(command, argv, env);
      throw new Error("this Bun runtime does not implement process.execve");
    },
    catch: processError,
  });
}
