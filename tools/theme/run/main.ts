import { runMain } from "@dotfiles/core/runtime";
import { or, seq } from "@optique/core/constructs";
import { runParser } from "@optique/core/facade";
import { message } from "@optique/core/message";
import { map } from "@optique/core/modifiers";
import { argument, flag, passThrough } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { Config, ConfigProvider, Effect, Runtime, Schema, Stdio, Stream } from "effect";
import { Manifest, name, version } from "./config.ts";
import {
  execUnknown,
  executionStatus,
  prepareInvocation,
  runInvocation,
} from "./launch.ts";
import { detect } from "./theme.ts";

const usageErrorStatus = 2;

function write(text: string, error = false) {
  return Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.run(Stream.make(text), error ? stdio.stderr() : stdio.stdout());
  });
}

export function run(args: string[]) {
  return Effect.gen(function* () {
    const output: Array<{ text: string; error: boolean }> = [];
    const parser = or(
      map(
        flag("--print-theme", {
          description: message`Print the detected terminal theme (dark or light)`,
        }),
        () => ({ printTheme: true, command: [] }),
      ),
      map(
        flag("--print-theme-no-terminal", {
          description: message`Print the theme without reading terminal input`,
        }),
        () => ({ printTheme: false, command: [] }),
      ),
      map(
        seq(
          argument(string({ metavar: "COMMAND" })),
          passThrough({ format: "greedy" }),
        ),
        ([command, args]) => ({
          printTheme: undefined,
          command: [command, ...args],
        }),
      ),
    );
    let status: number | undefined;
    const options = runParser(parser, name, args.length ? args : ["--help"], {
      brief: message`Run a command with terminal theme integration`,
      help: {
        option: { names: ["-h", "--help"] },
        onShow: () => {
          status = 0;
        },
      },
      version: {
        option: true,
        value: `${name} version ${version}`,
        onShow: () => {
          status = 0;
        },
      },
      onError: () => {
        status = usageErrorStatus;
      },
      stdout: (text) => {
        output.push({ text: `${text}\n`, error: false });
      },
      stderr: (text) => {
        output.push({ text: `${name}: ${text}\n`, error: true });
      },
    });
    for (const entry of output) yield* write(entry.text, entry.error);
    if (status !== undefined) return status;
    const printTheme = options.printTheme !== undefined;
    const command = options.command;
    // Read the exact environment, including empty values and underscore keys
    const provider = yield* Effect.sync(() =>
      ConfigProvider.fromUnknown(
        Object.fromEntries(
          Object.entries(process.env).filter((entry) => entry[1] !== undefined),
        ),
        { preserveEmptyStrings: true },
      ),
    );
    const env = yield* Config.schema(Schema.Record(Schema.String, Schema.String)).parse(
      provider,
    );
    const manifest = yield* Manifest.load(env).pipe(
      Effect.catch((error) =>
        write(`${name}: failed to load configuration: ${error.message}\n`, true).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (!manifest) return 1;
    if (printTheme) {
      yield* write(`${yield* detect(manifest.runtime, env, !!options.printTheme)}\n`);
      return 0;
    }
    const requested = command[0];
    if (!requested) return 0;
    const runner = manifest.findRunner(requested);
    if (!runner) return yield* execUnknown(command, env);
    return yield* Effect.scoped(
      prepareInvocation(manifest, runner, requested, command.slice(1), env).pipe(
        Effect.flatMap(runInvocation),
      ),
    ).pipe(
      Effect.catch((error) =>
        write(
          `${name}: failed to run ${requested}: ${error instanceof Error ? error.message : String(error)}\n`,
          true,
        ).pipe(Effect.as(executionStatus(error))),
      ),
    );
  });
}

if (import.meta.main) {
  runMain(
    run(process.argv.slice(2)).pipe(
      Effect.tap((code) =>
        Effect.sync(() => {
          process.exitCode = code;
        }),
      ),
    ),
    {
      teardown: (exit, onExit) => {
        if (typeof process.exitCode === "number") onExit(process.exitCode);
        else Runtime.defaultTeardown(exit, onExit);
      },
    },
  );
}
