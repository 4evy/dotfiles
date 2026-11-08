import { delimiter, isAbsolute, join } from "node:path";
import { DotfilesError } from "@dotfiles/core/errors";
import { isExecutable } from "@dotfiles/core/files";
import { exitCode } from "@dotfiles/runtime/process";
import { Effect, FileSystem, Option } from "effect";
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
import { replaceProcess, signalHandlers, spawn } from "./process.ts";
import { detect } from "./theme.ts";

const commandNotFoundStatus = 127;
const commandNotExecutableStatus = 126;
const fallbackSearchPath = "/usr/local/bin:/usr/bin:/bin";
const shebangReadBytes = 512;
const temporarySuffixLength = "XXXXXX".length;
const sharedDirectoryMode = 0o755;
const privateConfigMode = 0o600;
const fallbackTemporaryDirectory = "/tmp";
const themePlaceholder = "{theme}";

interface Prepared {
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
  return errorCode(error) === "ENOENT"
    ? commandNotFoundStatus
    : commandNotExecutableStatus;
}

function expandPath(value: string, env: Variables): string {
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

function candidate(raw: string, skipPaths: string[], env: Variables) {
  return Effect.gen(function* () {
    let value = raw;
    if (raw.startsWith("$")) {
      value = env[raw.slice(1)] ?? "";
      if (!value) return undefined;
    }
    value = expandPath(value, env);
    if (value.includes("/")) return yield* executableCandidate(value, skipPaths);
    for (const directory of (env.PATH || fallbackSearchPath).split(delimiter)) {
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
        cause: Object.assign(new Error("file does not exist"), {
          code: "ENOENT",
        }),
      }),
    );
  });
}

function usesInterpreter(interpreter: Interpreter, path: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(path, { flag: "r" });
      const buffer = Buffer.allocUnsafe(shebangReadBytes);
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

function configArguments(
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

function patchAssignment(
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
    // The scoped platform directory owns uniqueness and cleanup, including failure
    const directory =
      integration.temporary_location === "system"
        ? env.TMPDIR || fallbackTemporaryDirectory
        : join(
            env.XDG_CACHE_HOME ||
              (env.HOME ? join(env.HOME, ".cache") : fallbackTemporaryDirectory),
            integration.cache_subdirectory,
          );
    yield* fs.makeDirectory(directory, { recursive: true, mode: sharedDirectoryMode });
    const temporary = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: integration.temporary_prefix.slice(0, -temporarySuffixLength),
    });
    const path = join(temporary, "config");
    yield* fs.writeFileString(path, contents, { flag: "wx", mode: privateConfigMode });
    return path;
  });
}

function prepare(
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
            argument.replaceAll(themePlaceholder, theme),
          ),
          ...extra,
        ];
        break;
      case "environment":
        for (const [key, template] of Object.entries(integration.env)) {
          result.environment[key] = template
            .replaceAll(themePlaceholder, theme)
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
  return signalHandlers((signal) => {
    // Signal delivery is a native callback boundary, not a process engine
    // The child may have exited before its exit notification is observed
    try {
      process.kill(pid, signal);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    }
  });
}

export function runInvocation(invocation: Invocation) {
  return Effect.gen(function* () {
    const [command, ...args] = invocation.argv;
    if (!command) return yield* Effect.fail(new DotfilesError("empty command"));
    if (!invocation.temporaryPath) {
      // Replacement preserves the PID, job control, signals and exit status
      return yield* replaceProcess(command, invocation.argv, invocation.environment);
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawn(command, args, {
          env: invocation.environment,
          extendEnv: false,
          stdin: "inherit",
          detached: false,
          stdout: "inherit",
          stderr: "inherit",
        });
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

function lookPath(command: string, env: Variables) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let permissionDenied = false;
    for (const directory of (env.PATH ?? "").split(delimiter)) {
      const candidatePath = directory ? join(directory, command) : command;
      const executable = yield* executableCandidate(candidatePath, []);
      if (executable)
        return isAbsolute(executable) ? executable : commandNotExecutableStatus;
      const info = yield* fs
        .stat(candidatePath)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (info?.type === "File") permissionDenied = true;
    }
    return permissionDenied ? commandNotExecutableStatus : commandNotFoundStatus;
  });
}

export function execUnknown(argv: string[], env: Variables) {
  return Effect.gen(function* () {
    const command = argv[0];
    if (!command) return commandNotFoundStatus;
    // Unlike profile resolution, LookPath rejects implicit CWD execution
    const path = command.includes("/") ? command : yield* lookPath(command, env);
    if (typeof path === "number") return path;
    return yield* replaceProcess(path, argv, env);
  }).pipe(Effect.catch((error) => Effect.succeed(executionStatus(error))));
}
