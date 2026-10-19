import { Effect } from "effect";
import type { CommandResult } from "./commands.ts";
import { DotfilesError } from "./errors.ts";

export type ProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  stderr?: "pipe" | "inherit" | "ignore";
};

export function execute(
  command: string[],
  options: ProcessOptions = {},
): Effect.Effect<CommandResult, DotfilesError> {
  return Effect.tryPromise({
    try: async (signal) => {
      if (!command.length) throw new DotfilesError("execute requires a command");
      const child = Bun.spawn(command, {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        stdin: options.input === undefined ? "ignore" : Buffer.from(options.input),
        stdout: "pipe",
        stderr: options.stderr ?? "pipe",
        signal,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.stderr instanceof ReadableStream
          ? new Response(child.stderr).text()
          : Promise.resolve(""),
        child.exited,
      ]);
      return { stdout, stderr, code };
    },
    catch: (cause) =>
      new DotfilesError(
        `Could not run ${command[0] ?? "command"}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      ),
  });
}

export function run(
  command: string[],
  options: ProcessOptions = {},
): Effect.Effect<string, DotfilesError> {
  return Effect.gen(function* () {
    const result = yield* execute(command, options);
    if (result.code !== 0)
      return yield* Effect.fail(
        new DotfilesError(
          `${command[0]} failed (${result.code}): ${result.stderr.trim()}`,
        ),
      );
    return result.stdout;
  });
}
