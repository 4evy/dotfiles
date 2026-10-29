#!/usr/bin/env bun
import { basename } from "node:path";
import { UsageError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Cause, Console, Effect } from "effect";
import { type CommandName, commandNames, commands } from "./registry.ts";

function help(command?: CommandName) {
  return Effect.gen(function* () {
    if (!command) {
      yield* Console.log("Usage: workstation COMMAND [ARGUMENTS...]");
      yield* Console.log(commandNames.join("\n"));
      return;
    }
    const entry = commands[command];
    yield* Console.log(`Usage: ${command}${entry.usage ? ` ${entry.usage}` : ""}`);
    if (entry.environment.length)
      yield* Console.log(`Environment: ${entry.environment.join(", ")}`);
  });
}

if (import.meta.main) {
  // Bun preserves the invocation name in argv0, not execPath or argv[0]
  const invokedAs = basename(process.argv0);
  const args = process.argv.slice(2);
  const command = Object.hasOwn(commands, invokedAs) ? invokedAs : args.shift();
  runMain(
    Effect.gen(function* () {
      if (!command || command === "--help" || command === "-h") {
        yield* help();
        return;
      }
      const entry = Object.hasOwn(commands, command)
        ? commands[command as CommandName]
        : undefined;
      if (!entry)
        return yield* Effect.fail(
          new UsageError(`Unknown workstation command: ${command}`),
        );
      if (args.includes("--help") || args.includes("-h"))
        yield* help(command as CommandName);
      else {
        const code = yield* entry.run(args);
        yield* Effect.sync(() => {
          process.exitCode = code;
        });
      }
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const error = Cause.squash(cause);
        return Effect.gen(function* () {
          yield* Console.error(
            `${command ?? "workstation"}: ${error instanceof Error ? error.message : String(error)}`,
          );
          yield* Effect.sync(() => {
            process.exitCode =
              error instanceof UsageError ? 64 : command === "jj-diff" ? 2 : 1;
          });
        });
      }),
    ),
  );
}
