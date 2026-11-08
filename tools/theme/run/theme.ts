import { closeSync, constants, openSync, readSync, writeSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { ReadStream } from "node:tty";
import { DotfilesError } from "@dotfiles/core/errors";
import { exitCode } from "@dotfiles/runtime/process";
import { Data, Deferred, Effect, Stream } from "effect";
import { ChildProcess } from "effect/process";
import type { Runtime, Theme, Variables } from "./config.ts";

const backgroundQuery = "\x1b]11;?\x07";
const schemeQuery = "\x1b[?996n";

export function modeFromText(runtime: Runtime, text: string): Theme | undefined {
  let normalized = text.trim();
  const lower = normalized.toLowerCase();
  for (const mode of ["dark", "light"] as const) {
    if (lower.includes(mode)) return mode;
  }
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith("'") && normalized.endsWith("'")) ||
      (normalized.startsWith('"') && normalized.endsWith('"')))
  )
    normalized = normalized.slice(1, -1);
  for (const mode of ["dark", "light"] as const) {
    if (
      runtime.theme_aliases[mode].some(
        (alias) => alias.toLowerCase() === normalized.toLowerCase(),
      )
    )
      return mode;
  }
  return undefined;
}

export function terminalQueries(runtime: Runtime, env: Variables): string[] {
  for (const identifier of [
    env[runtime.theme_terminal_program_environment] ?? "",
    env.TERM ?? "",
    "*",
  ]) {
    const entry = Object.entries(runtime.theme_terminal_queries).find(
      ([key]) => key.toLowerCase() === identifier.toLowerCase(),
    );
    if (entry)
      return entry[1] === "color-scheme"
        ? [schemeQuery, backgroundQuery]
        : [backgroundQuery];
  }
  return [];
}

// Match ultraviolet's 8-bit channel conversion and rounded HSL lightness
function backgroundMode(value: string): Theme | undefined {
  let channels: number[];
  if (/^#[\da-f]{3}$/i.test(value)) {
    channels = [...value.slice(1)].map((part) => Number.parseInt(part + part, 16));
  } else if (/^#[\da-f]{6}$/i.test(value)) {
    channels = [1, 3, 5].map((offset) =>
      Number.parseInt(value.slice(offset, offset + 2), 16),
    );
  } else if (value.startsWith("rgb:") || value.startsWith("rgba:")) {
    const alpha = value.startsWith("rgba:");
    const parts = value.slice(alpha ? 5 : 4).split("/");
    if (parts.length !== (alpha ? 4 : 3)) return undefined;
    channels = parts
      .map((part) => {
        const channel = /^[\da-f]+$/i.test(part) ? Number.parseInt(part, 16) : 0;
        return (channel > 255 ? channel >>> 8 : channel) & 255;
      })
      .slice(0, 3);
  } else {
    return undefined;
  }
  const lightness = (Math.max(...channels) + Math.min(...channels)) / 510;
  return Math.round(lightness * 1000) / 1000 < 0.5 ? "dark" : "light";
}

export function modeFromTerminal(text: string): Theme | undefined {
  const events =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI protocol bytes
    /(?:\x1b\[|\x9b)\?997;([12])n|(?:\x1b\]|\x9d)11;([^\x07\x1b\x9c]*)(?:\x07|\x1b\\|\x9c)/g;
  for (const match of text.matchAll(events)) {
    if (match[1]) return match[1] === "1" ? "dark" : "light";
    const mode = backgroundMode(match[2] ?? "");
    if (mode) return mode;
  }
  return undefined;
}

// A nonblocking controlling-terminal descriptor avoids Bun's uncancellable tty
// stream reads, while libuv's tty handle saves and restores the original flags
function openTerminal() {
  return Effect.try({
    try: () => {
      const descriptor = openSync("/dev/tty", constants.O_RDWR | constants.O_NONBLOCK);
      let input: ReadStream | undefined;
      try {
        input = new ReadStream(descriptor);
        input.setRawMode(true);
        return { descriptor, input };
      } catch (cause) {
        if (input) input.destroy();
        else closeSync(descriptor);
        throw cause;
      }
    },
    catch: (cause) => new DotfilesError("cannot open controlling terminal", { cause }),
  });
}

function closeTerminal(terminal: { input: ReadStream }) {
  return Effect.callback<void>((resume) => {
    try {
      terminal.input.setRawMode(false);
    } catch {
      // A disconnected terminal has no remaining flags to restore
    }
    terminal.input.pause();
    terminal.input.once("close", () => resume(Effect.void));
    terminal.input.destroy();
  });
}

class TerminalSignal extends Data.TaggedError("TerminalSignal")<{
  signal: NodeJS.Signals;
}> {}

function terminalSignal() {
  return Effect.gen(function* () {
    const interrupted = yield* Deferred.make<never, TerminalSignal>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const handlers = new Map<NodeJS.Signals, () => void>();
        for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const) {
          const handler = () => {
            process.exitCode = 128 + osConstants.signals[signal];
            Deferred.doneUnsafe(
              interrupted,
              Effect.fail(new TerminalSignal({ signal })),
            );
          };
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
    return Deferred.await(interrupted);
  });
}

export function probeTerminal(query: string, timeout: number) {
  return Effect.scoped(
    Effect.gen(function* () {
      // Install handlers before entering raw mode or exposing query bytes
      const signal = yield* terminalSignal();
      const terminal = yield* Effect.acquireRelease(openTerminal(), closeTerminal);
      return yield* Effect.gen(function* () {
        const buffer = Buffer.allocUnsafe(4096);
        let received = "";
        yield* Effect.try({
          try: () => writeSync(terminal.descriptor, query),
          catch: (cause) => new DotfilesError("terminal query failed", { cause }),
        });
        for (;;) {
          const length = yield* Effect.try({
            try: () => readSync(terminal.descriptor, buffer, 0, buffer.length, null),
            catch: (cause) => new DotfilesError("terminal read failed", { cause }),
          }).pipe(
            Effect.catch((error) =>
              ["EAGAIN", "EWOULDBLOCK", "EINTR"].includes(
                (error.cause as NodeJS.ErrnoException)?.code ?? "",
              )
                ? Effect.succeed(-1)
                : Effect.fail(error),
            ),
          );
          if (length === 0) return undefined;
          if (length > 0) {
            received = (received + buffer.toString("latin1", 0, length)).slice(-8192);
            const mode = modeFromTerminal(received);
            if (mode) return mode;
          }
          yield* Effect.sleep(5);
        }
      }).pipe(
        Effect.raceFirst(signal),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.succeed(undefined),
        }),
      );
    }),
  ).pipe(
    // Interrupt only after scope cleanup, preserving the native signal status
    Effect.catchTag("TerminalSignal", () => Effect.interrupt),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

export function runCommandOutput(runtime: Runtime, env: Variables, argv: string[]) {
  return Effect.scoped(
    Effect.gen(function* () {
      const [command, ...args] = argv;
      if (!command)
        return yield* Effect.fail(new DotfilesError("empty helper command"));
      const child = yield* ChildProcess.make(command, args, {
        env,
        extendEnv: false,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGKILL",
      }).pipe(
        Effect.catchDefect((cause) =>
          Effect.fail(
            new DotfilesError(cause instanceof Error ? cause.message : String(cause), {
              cause,
            }),
          ),
        ),
      );
      const output: Uint8Array[] = [];
      const drain = (stream: Stream.Stream<Uint8Array, unknown>, capture: boolean) => {
        let length = 0;
        return Stream.runForEach(stream, (bytes) => {
          length += bytes.length;
          if (length > runtime.helper_output_limit_bytes)
            return Effect.fail(new DotfilesError("helper output limit exceeded"));
          if (capture) output.push(bytes);
          return Effect.void;
        });
      };
      const [code] = yield* Effect.all(
        [exitCode(child), drain(child.stdout, true), drain(child.stderr, false)],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* Effect.fail(
          new DotfilesError(`helper exited with status ${code}`),
        );
      return Buffer.concat(output).toString();
    }).pipe(
      Effect.timeoutOrElse({
        duration: runtime.helper_timeout_ms,
        orElse: () => Effect.fail(new DotfilesError("helper command timed out")),
      }),
    ),
  );
}

export function detect(runtime: Runtime, env: Variables, withTerminal: boolean) {
  return Effect.gen(function* () {
    for (const variable of runtime.theme_environment) {
      const mode = modeFromText(runtime, env[variable] ?? "");
      if (mode) return mode;
    }
    if (withTerminal) {
      for (const query of terminalQueries(runtime, env)) {
        const mode = yield* probeTerminal(query, runtime.theme_probe_timeout_ms);
        if (mode) return mode;
      }
    }
    const platform =
      runtime.theme_platforms[process.platform] ?? runtime.theme_platforms["*"];
    if (!platform) return yield* Effect.fail(new DotfilesError("no platform fallback"));
    for (const argv of platform.commands) {
      const text = yield* runCommandOutput(runtime, env, argv).pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      const mode = modeFromText(runtime, text);
      if (mode) return mode;
    }
    return platform.fallback;
  });
}
