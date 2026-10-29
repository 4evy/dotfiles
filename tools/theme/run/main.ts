import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Command, CommanderError, Option } from "commander";
import { Config, ConfigProvider, Effect, Runtime, Schema, Stdio, Stream } from "effect";
import { Manifest, name, version } from "./config.ts";
import {
  execUnknown,
  executionStatus,
  prepareInvocation,
  runInvocation,
} from "./launch.ts";
import { detect } from "./theme.ts";

function write(text: string, error = false) {
  return Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.run(Stream.make(text), error ? stdio.stderr() : stdio.stdout());
  });
}

export function run(args: string[]) {
  return Effect.gen(function* () {
    const output: Array<{ text: string; error: boolean }> = [];
    const parser = new Command(name)
      .description(
        "Run a command with terminal theme integration when a matching profile exists.",
      )
      .addOption(
        new Option(
          "--print-theme",
          "Print the detected terminal theme (dark or light).",
        ).conflicts("printThemeNoTerminal"),
      )
      .addOption(
        new Option(
          "--print-theme-no-terminal",
          "Print the theme without reading terminal input.",
        ).conflicts("printTheme"),
      )
      .version(`${name} version ${version}`, "--version", "Show program version.")
      .argument("[command...]", "COMMAND [ARG...]")
      .passThroughOptions()
      .exitOverride()
      .configureOutput({
        writeOut: (text) => {
          output.push({ text, error: false });
        },
        writeErr: (text) => {
          output.push({
            text: `${name}: ${text.replace(/^error: /, "")}`,
            error: true,
          });
        },
      });
    const parsed = yield* Effect.try({
      try: () => {
        try {
          parser.parse(args, { from: "user" });
          return undefined;
        } catch (error) {
          if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
          throw error;
        }
      },
      catch: (cause) => new DotfilesError(String(cause), { cause }),
    });
    for (const entry of output) yield* write(entry.text, entry.error);
    if (parsed !== undefined) return parsed;
    const options = parser.opts<{
      printTheme?: boolean;
      printThemeNoTerminal?: boolean;
    }>();
    const printTheme = options.printTheme || options.printThemeNoTerminal;
    const command = parser.args;
    if (printTheme && command.length) {
      yield* write(`${name}: theme printing does not accept a command\n`, true);
      return 2;
    }
    if (!printTheme && !command.length) {
      yield* write(parser.helpInformation());
      return 0;
    }
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
