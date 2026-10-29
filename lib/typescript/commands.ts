import { exitCode } from "@dotfiles/runtime/process";
import { Effect, Stdio, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { DotfilesError } from "./errors.ts";

export type RunOptions = {
  check?: boolean;
  capture?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  stdin?: "inherit" | "ignore";
  timeout?: number;
  outputMode?: "inherit" | "stderr" | "discard";
  stderr?: "inherit" | "pipe" | "ignore";
};
export type CommandResult = { code: number; stdout: string; stderr: string };

const encoder = new TextEncoder();

export function requireCommands(...names: string[]) {
  return Effect.suspend(() => {
    const missing = names.find((name) => !Bun.which(name));
    return missing
      ? Effect.fail(new DotfilesError(`Required command is not available: ${missing}`))
      : Effect.void;
  });
}

function commandFailure(argv: readonly string[], result: CommandResult): DotfilesError {
  const details = result.stderr.trim() || result.stdout.trim();
  return new DotfilesError(
    `Command failed (${result.code}): ${argv.map(shellQuote).join(" ")}${details ? `\n${details}` : ""}`,
  );
}

export function run(argv: readonly string[], options: RunOptions = {}) {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const [command, ...args] = argv;
      if (!command)
        return yield* Effect.fail(new DotfilesError("run requires a command"));
      const stderr = options.stderr ?? (options.capture ? "pipe" : "inherit");
      const redirect = !options.capture && options.outputMode === "stderr";
      const child = yield* ChildProcess.make(command, args, {
        cwd: options.cwd,
        env: options.env,
        extendEnv: true,
        // Keep the controlling terminal even when standard streams are redirected
        detached: false,
        stdin:
          options.input === undefined
            ? (options.stdin ?? "inherit")
            : Stream.make(encoder.encode(options.input)),
        stdout:
          options.capture || redirect
            ? "pipe"
            : options.outputMode === "discard"
              ? "ignore"
              : "inherit",
        stderr,
      }).pipe(
        // Bun can throw before the platform establishes its native error channel
        Effect.catchDefect((cause) =>
          Effect.fail(new DotfilesError(`Could not run ${command}`, { cause })),
        ),
      );
      const stdout = options.capture
        ? Stream.mkString(Stream.decodeText(child.stdout))
        : redirect
          ? Stream.run(child.stdout, (yield* Stdio.Stdio).stderr()).pipe(Effect.as(""))
          : Effect.succeed("");
      // Drain both pipes while waiting, so neither can block the child
      const completed = yield* Effect.all(
        {
          code: exitCode(child),
          stdout,
          stderr:
            stderr === "pipe"
              ? Stream.mkString(Stream.decodeText(child.stderr))
              : Effect.succeed(""),
        },
        { concurrency: "unbounded" },
      );
      if (options.check !== false && completed.code !== 0)
        return yield* Effect.fail(commandFailure(argv, completed));
      return completed;
    }),
  );
  const timed =
    options.timeout === undefined
      ? program
      : program.pipe(
          Effect.timeoutOrElse({
            duration: options.timeout * 1000,
            orElse: () =>
              Effect.fail(
                new DotfilesError(
                  `Command timed out after ${options.timeout} seconds: ${argv[0]}`,
                ),
              ),
          }),
        );
  return timed.pipe(
    Effect.mapError((cause) =>
      cause instanceof DotfilesError
        ? cause
        : new DotfilesError(`Could not run ${argv[0]}: ${cause.message}`, { cause }),
    ),
  );
}

export function output(
  argv: readonly string[],
  options: Omit<RunOptions, "capture"> = {},
) {
  return run(argv, { ...options, capture: true }).pipe(
    Effect.map((result) => result.stdout.replace(/\n+$/, "")),
  );
}

// Keep POSIX quoting stable for exact legacy launcher recognition
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function execProcess(
  path: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  argumentZero = path,
) {
  return Effect.try({
    try: (): never => {
      const executable = Bun.which(path);
      if (!executable) throw new DotfilesError(`Command is not available: ${path}`);
      if (!process.execve)
        throw new DotfilesError("This Bun version does not support process.execve");
      process.execve(executable, [argumentZero, ...args], env);
      throw new DotfilesError(`Could not execute ${path}`);
    },
    catch: (cause) =>
      cause instanceof DotfilesError
        ? cause
        : new DotfilesError(`Could not execute ${path}`, { cause }),
  });
}
