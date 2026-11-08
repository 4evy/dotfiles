#!/usr/bin/env bun
import { basename } from "node:path";
import { UsageError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { object, or } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { map, multiple } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import {
  constant,
  flag,
  passThrough,
  command as subcommand,
} from "@optique/core/primitives";
import { Cause, Console, Effect } from "effect";
import { forwardedArguments } from "./lib/arguments.ts";
import { type CommandName, commandNames, commands } from "./registry.ts";

const USAGE_ERROR_EXIT_CODE = 64;
const JJ_DIFF_ERROR_EXIT_CODE = 2;

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
  let command: CommandName | undefined;
  runMain(
    Effect.gen(function* () {
      const parsed = parseSync(
        or(
          or(
            ...commandNames.map((name) =>
              map(subcommand(name, passThrough({ format: "greedy" })), (args) => ({
                command: name,
                args,
              })),
            ),
          ),
          map(
            object({
              help: flag("-h", "--help"),
              args: passThrough({ format: "greedy" }),
            }),
            () => undefined,
          ),
          constant(undefined),
        ),
        Object.hasOwn(commands, invokedAs) ? [invokedAs, ...args] : args,
      );
      if (!parsed.success)
        return yield* Effect.fail(new UsageError(formatMessage(parsed.error)));
      if (!parsed.value) {
        yield* help();
        return;
      }
      command = parsed.value.command;
      const entry = commands[command];
      const forwarded = [...parsed.value.args];
      const meta = parseSync(
        object({
          help: map(multiple(flag("-h", "--help")), (values) => values.length > 0),
          arguments: forwardedArguments,
        }),
        forwarded,
      );
      if (!meta.success)
        return yield* Effect.fail(new UsageError(formatMessage(meta.error)));
      if (meta.value.help) yield* help(command);
      else {
        const code = yield* entry.run(forwarded);
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
              error instanceof UsageError
                ? USAGE_ERROR_EXIT_CODE
                : command === "jj-diff"
                  ? JJ_DIFF_ERROR_EXIT_CODE
                  : 1;
          });
        });
      }),
    ),
  );
}
