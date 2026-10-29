import { delimiter, isAbsolute, join } from "node:path";
import { DotfilesError } from "@dotfiles/core/errors";
import { isExecutable } from "@dotfiles/core/files";
import { exitCode } from "@dotfiles/runtime/process";
import { Crypto, Effect, FileSystem, Option } from "effect";
import { ChildProcess } from "effect/process";
import {
  errorCode,
  type Integration,
  type Interpreter,
  type Manifest,
  type Runner,
  readFile,
  type Theme,
  type Variables,
} from "./config.ts";
import { detect } from "./theme.ts";

export interface Prepared {
  args: string[];
  environment: Variables;
  temporaryPath: string;
}
export interface Invocation {
  argv: string[];
  environment: Variables;
  temporaryPath: string;
}

export function executionStatus(error: unknown): number {
  return errorCode(error) === "ENOENT" ? 127 : 126;
}

export function expandPath(value: string, env: Variables): string {
  return value.startsWith("~/") && env.HOME ? join(env.HOME, value.slice(2)) : value;
}

function executableCandidate(path: string, skipPaths: string[]) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path);
    if (info.type !== "File" || !(yield* isExecutable(path))) return undefined;
    for (const skipped of skipPaths) {
      const other = yield* fs
        .stat(skipped)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (
        other &&
        info.dev === other.dev &&
        Option.isSome(info.ino) &&
        Option.isSome(other.ino) &&
        info.ino.value === other.ino.value
      )
        return undefined;
    }
    return path;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

export function candidate(raw: string, skipPaths: string[], env: Variables) {
  return Effect.gen(function* () {
    let value = raw;
    if (raw.startsWith("$")) {
      value = env[raw.slice(1)] ?? "";
      if (!value) return undefined;
    }
    value = expandPath(value, env);
    if (value.includes("/")) return yield* executableCandidate(value, skipPaths);
    for (const directory of (env.PATH || "/usr/local/bin:/usr/bin:/bin").split(
      delimiter,
    )) {
      const path = yield* executableCandidate(
        directory ? join(directory, value) : value,
        skipPaths,
      );
      if (path) return path;
    }
    return undefined;
  });
}

function resolve(runner: Runner, requested: string, env: Variables) {
  return Effect.gen(function* () {
    if (requested.includes("/")) return requested;
    const skipPaths = runner.skip_env.flatMap((key) =>
      (env[key] ?? "").split(delimiter),
    );
    skipPaths.push(process.execPath);
    const requestedPath = yield* candidate(requested, skipPaths, env);
    if (requestedPath) return requestedPath;
    for (const program of runner.programs.length ? runner.programs : [runner.name]) {
      if (program === requested) continue;
      const path = yield* candidate(program, skipPaths, env);
      if (path) return path;
    }
    return yield* Effect.fail(
      new DotfilesError("file does not exist", {
        cause: Object.assign(new Error("file does not exist"), { code: "ENOENT" }),
      }),
    );
  });
}

function usesInterpreter(interpreter: Interpreter, path: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(path, { flag: "r" });
      const buffer = Buffer.allocUnsafe(512);
      const bytesRead = yield* file.read(buffer);
      const line = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0] ?? "";
      if (!line.startsWith("#!")) return false;
      const [command, argument] = line.slice(2).trim().split(/\s+/);
      return (
        !!command &&
        !!argument &&
        interpreter.shebang_commands.includes(command) &&
        interpreter.shebang_arguments.includes(argument)
      );
    }),
  ).pipe(Effect.catch(() => Effect.succeed(false)));
}

export function configArguments(
  integration: Integration,
  arguments_: string[],
  env: Variables,
): [string, string[]] {
  let path: string | undefined;
  const filtered: string[] = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (integration.config_flags.includes(argument)) {
      const next = arguments_[index + 1];
      if (next !== undefined) {
        index++;
        path ??= expandPath(next, env);
      }
      continue;
    }
    const flag = integration.config_flags.find((flag) =>
      argument.startsWith(`${flag}=`),
    );
    if (flag !== undefined) path ??= expandPath(argument.slice(flag.length + 1), env);
    else filtered.push(argument);
  }
  return [
    path ?? (env.HOME ? join(env.HOME, integration.default_config) : ""),
    filtered,
  ];
}

export function patchAssignment(
  contents: string,
  key: string,
  quote: string,
  value: string,
): string {
  const assignment = `${key} = ${quote}${value}${quote}`;
  let replaced = false;
  let output = "";
  for (const match of contents.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const line = match[0];
    const trimmed = line.replace(/^[ \t]*/, "");
    if (
      !replaced &&
      trimmed.startsWith(key) &&
      trimmed
        .slice(key.length)
        .replace(/^[ \t]*/, "")
        .startsWith("=")
    ) {
      output += assignment + (line.endsWith("\n") ? "\n" : "");
      replaced = true;
    } else output += line;
  }
  if (!replaced)
    output += `${output && !output.endsWith("\n") ? "\n" : ""}${assignment}\n`;
  return output;
}

function makeTemporary(integration: Integration, contents: string, env: Variables) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const directory =
      integration.temporary_location === "system"
        ? env.TMPDIR || "/tmp"
        : join(
            env.XDG_CACHE_HOME || (env.HOME ? join(env.HOME, ".cache") : "/tmp"),
            integration.cache_subdirectory,
          );
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o755 });
    const stem = integration.temporary_prefix.slice(0, -6);
    for (;;) {
      const path = join(
        directory,
        stem + Buffer.from(yield* crypto.randomBytes(8)).toString("hex"),
      );
      const temporary = yield* Effect.acquireRelease(
        fs
          .open(path, { flag: "wx", mode: 0o600 })
          .pipe(Effect.map((file) => ({ path, file }))),
        ({ path }) => fs.remove(path, { force: true }).pipe(Effect.orDie),
      ).pipe(
        Effect.catch((error) =>
          errorCode(error) === "EEXIST"
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      );
      if (!temporary) continue;
      yield* temporary.file.writeAll(Buffer.from(contents));
      return path;
    }
  });
}

export function prepare(
  integration: Integration | undefined,
  extra: string[],
  env: Variables,
  mode: Theme,
) {
  return Effect.gen(function* () {
    const result: Prepared = {
      args: [...extra],
      environment: Object.create(null),
      temporaryPath: "",
    };
    if (!integration) return result;
    const theme = mode === "dark" ? integration.dark_theme : integration.light_theme;
    switch (integration.strategy) {
      case "arguments":
        result.args = [
          ...integration.arguments.map((argument) =>
            argument.replaceAll("{theme}", theme),
          ),
          ...extra,
        ];
        break;
      case "environment":
        for (const [key, template] of Object.entries(integration.env)) {
          result.environment[key] = template
            .replaceAll("{theme}", theme)
            .replaceAll("{home}", env.HOME ?? "");
        }
        break;
      case "config": {
        const [path, arguments_] = configArguments(integration, extra, env);
        const contents = yield* readFile(path).pipe(
          Effect.catch((error) =>
            errorCode(error) === "ENOENT" ? Effect.succeed("") : Effect.fail(error),
          ),
        );
        result.temporaryPath = yield* makeTemporary(
          integration,
          patchAssignment(contents, integration.assignment, integration.quote, theme),
          env,
        );
        result.args = [
          integration.config_output_flag,
          result.temporaryPath,
          ...arguments_,
        ];
        break;
      }
    }
    return result;
  });
}

export function prepareInvocation(
  manifest: Manifest,
  runner: Runner,
  requested: string,
  extra: string[],
  env: Variables,
  forcedTheme?: Theme,
) {
  return Effect.gen(function* () {
    const executable = yield* resolve(runner, requested, env);
    const mode = forcedTheme ?? (yield* detect(manifest.runtime, env, true));
    const prepared = yield* prepare(
      manifest.integrations.get(runner.integration),
      extra,
      env,
      mode,
    );
    const argv = [executable];
    const interpreter = manifest.interpreters.get(runner.interpreter);
    if (interpreter && (yield* usesInterpreter(interpreter, executable))) {
      let interpreterPath: string | undefined;
      for (const program of interpreter.programs) {
        interpreterPath = yield* candidate(program, [], env);
        if (interpreterPath) break;
      }
      if (!interpreterPath)
        return yield* Effect.fail(new DotfilesError("interpreter not found"));
      argv.unshift(interpreterPath);
    }
    argv.push(...runner.default_args, ...prepared.args);
    const environment: Variables = Object.assign(Object.create(null), env);
    for (const key of runner.env_unset) delete environment[key];
    Object.assign(environment, runner.env, prepared.environment, {
      THEME_RUN_ACTIVE: "1",
    });
    return {
      argv,
      environment,
      temporaryPath: prepared.temporaryPath,
    } satisfies Invocation;
  });
}

function forwardSignals(pid: number) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const handlers = new Map<NodeJS.Signals, () => void>();
      for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const) {
        const handler = () => {
          // Signal delivery is a native callback boundary, not a process engine
          // The child may have exited before its exit notification is observed
          try {
            process.kill(pid, signal);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
          }
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
}

export function runInvocation(invocation: Invocation) {
  return Effect.gen(function* () {
    const [command, ...args] = invocation.argv;
    if (!command) return yield* Effect.fail(new DotfilesError("empty command"));
    if (!invocation.temporaryPath) {
      // Replacement preserves the PID, job control, signals and exit status
      return yield* Effect.try({
        try: (): never => {
          process.execve?.(command, invocation.argv, invocation.environment);
          throw new Error("this Bun runtime does not implement process.execve");
        },
        catch: (cause) =>
          new DotfilesError(cause instanceof Error ? cause.message : String(cause), {
            cause,
          }),
      });
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* ChildProcess.make(command, args, {
          env: invocation.environment,
          extendEnv: false,
          stdin: "inherit",
          detached: false,
          stdout: "inherit",
          stderr: "inherit",
        }).pipe(
          Effect.catchDefect((cause) =>
            Effect.fail(
              new DotfilesError(
                cause instanceof Error ? cause.message : String(cause),
                { cause },
              ),
            ),
          ),
        );
        yield* forwardSignals(child.pid);
        const code = yield* exitCode(child);
        // Preserve the child's chosen status even if a runtime interrupt is
        // pending, including when the child handles a signal and exits zero
        yield* Effect.sync(() => {
          process.exitCode = code;
        });
        return code;
      }),
    ).pipe(Effect.uninterruptible);
  });
}

export function execUnknown(argv: string[], env: Variables) {
  return Effect.gen(function* () {
    const command = argv[0];
    if (!command) return 127;
    const fs = yield* FileSystem.FileSystem;
    let path = command;
    if (!command.includes("/")) {
      // Unlike profile resolution, LookPath rejects implicit CWD execution
      let found: string | undefined;
      let permissionDenied = false;
      for (const directory of (env.PATH ?? "").split(delimiter)) {
        const candidatePath = directory ? join(directory, command) : command;
        const executable = yield* executableCandidate(candidatePath, []);
        if (executable) {
          if (!isAbsolute(executable)) return 126;
          found = executable;
          break;
        }
        const info = yield* fs
          .stat(candidatePath)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (info?.type === "File") permissionDenied = true;
      }
      if (!found) return permissionDenied ? 126 : 127;
      path = found;
    }
    return yield* Effect.try({
      try: (): never => {
        process.execve?.(path, argv, env);
        throw new Error("this Bun runtime does not implement process.execve");
      },
      catch: (cause) =>
        new DotfilesError(cause instanceof Error ? cause.message : String(cause), {
          cause,
        }),
    });
  }).pipe(Effect.catch((error) => Effect.succeed(executionStatus(error))));
}
