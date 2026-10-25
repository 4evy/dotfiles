import { DotfilesError } from "./errors.ts";

export type RunOptions = {
  check?: boolean;
  capture?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
  outputMode?: "inherit" | "stderr" | "discard";
  stderr?: "inherit" | "pipe" | "ignore";
};
export type CommandResult = { code: number; stdout: string; stderr: string };

export function requireCommands(...names: string[]): void {
  const missing = names.find((name) => !Bun.which(name));
  if (missing) throw new DotfilesError(`Required command is not available: ${missing}`);
}

function spawn(argv: string[], options: RunOptions) {
  const stdout = options.capture
    ? "pipe"
    : options.outputMode === "discard"
      ? "ignore"
      : options.outputMode === "stderr"
        ? 2
        : "inherit";
  return Bun.spawnSync(argv, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: options.input === undefined ? "inherit" : Buffer.from(options.input),
    stdout,
    stderr: options.stderr ?? (options.capture ? "pipe" : "inherit"),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout * 1000 }),
  });
}

function commandFailure(argv: string[], result: CommandResult): DotfilesError {
  const details = result.stderr.trim() || result.stdout.trim();
  return new DotfilesError(
    `Command failed (${result.code}): ${argv.map(shellQuote).join(" ")}${details ? `\n${details}` : ""}`,
  );
}

export function run(argv: string[], options: RunOptions = {}): CommandResult {
  if (!argv.length) throw new DotfilesError("run requires a command");
  try {
    const result = spawn(argv, options);
    const completed = {
      code: result.exitCode,
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    };
    if (result.signalCode === "SIGTERM" && options.timeout !== undefined)
      throw new DotfilesError(
        `Command timed out after ${options.timeout} seconds: ${argv[0]}`,
      );
    if (options.check !== false && completed.code !== 0)
      throw commandFailure(argv, completed);
    return completed;
  } catch (error) {
    if (error instanceof DotfilesError) throw error;
    throw new DotfilesError(
      `Could not run ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function output(
  argv: string[],
  options: Omit<RunOptions, "capture"> = {},
): string {
  return run(argv, { ...options, capture: true }).stdout.replace(/\n+$/, "");
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
): never {
  const executable = Bun.which(path);
  if (!executable) throw new DotfilesError(`Command is not available: ${path}`);
  if (!process.execve)
    throw new DotfilesError("This Bun version does not support process.execve");
  process.execve(executable, [argumentZero, ...args], env);
  throw new DotfilesError(`Could not execute ${path}`);
}
