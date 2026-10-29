#!/usr/bin/env bun

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ChildProcess,
  ChildProcessSpawner,
  Config,
  Console,
  Data,
  Effect,
  FileSystem,
  HttpClient,
  runMain,
  Schema,
  Stream,
} from "@dotfiles/runtime/runtime";

const START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 25;
const CACHE_FILE_NAME = "helium-user-agent.json";
const CacheEntry = Schema.fromJsonString(
  Schema.Struct({
    browserVersion: Schema.String,
    userAgent: Schema.String,
  }),
);
const BrowserMetadata = Schema.Struct({ "User-Agent": Schema.String });
class HeliumError extends Data.TaggedError("HeliumError")<{
  readonly message: string;
}> {}

function parseArguments(arguments_: string[]): { refresh: boolean } {
  if (arguments_.length === 0) return { refresh: false };
  if (arguments_.length === 1 && arguments_[0] === "--refresh")
    return { refresh: true };
  throw new HeliumError({ message: "usage: helium-user-agent [--refresh]" });
}

const readBrowserVersion = Effect.fn(function* (launcher: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(launcher, ["--version"], {
          stdin: "ignore",
          stderr: "pipe",
          stdout: "pipe",
          forceKillAfter: 3000,
        }),
      );
      const [code, stderr, stdout] = yield* Effect.all(
        [
          child.exitCode,
          Stream.mkString(Stream.decodeText(child.stderr)),
          Stream.mkString(Stream.decodeText(child.stdout)),
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* Effect.fail(
          new HeliumError({
            message: `Helium version check failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          }),
        );
      const version = stdout.trim();
      if (!version)
        return yield* Effect.fail(
          new HeliumError({ message: "Helium version check returned no output" }),
        );
      return version;
    }),
  );
});

const readCachedUserAgent = Effect.fn(function* (path: string, browserVersion: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );
  if (text === undefined) return undefined;
  const entry = yield* Schema.decodeUnknownEffect(CacheEntry)(text).pipe(Effect.option);
  return entry._tag === "Some" && entry.value.browserVersion === browserVersion
    ? entry.value.userAgent
    : undefined;
});

const writeCachedUserAgent = Effect.fn(function* (
  path: string,
  browserVersion: string,
  userAgent: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = dirname(path);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory,
        prefix: ".helium-user-agent-",
      });
      const temporaryPath = join(temporary, CACHE_FILE_NAME);
      yield* fs.writeFileString(
        temporaryPath,
        `${JSON.stringify({ browserVersion, userAgent })}\n`,
        { mode: 0o600 },
      );
      yield* fs.rename(temporaryPath, path);
    }),
  );
});

const probeUserAgent = Effect.fn(function* (launcher: string) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const client = yield* HttpClient.HttpClient;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const profile = yield* fs.makeTempDirectoryScoped({
        prefix: "helium-user-agent-",
      });
      const browser = yield* spawner.spawn(
        ChildProcess.make(
          launcher,
          [
            `--user-data-dir=${profile}`,
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-startup-window",
          ],
          { stdin: "ignore", stderr: "ignore", stdout: "ignore", forceKillAfter: 3000 },
        ),
      );
      const port = yield* Effect.gen(function* () {
        while (true) {
          const text = yield* fs
            .readFileString(join(profile, "DevToolsActivePort"))
            .pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.succeed(undefined),
              ),
            );
          const candidate = Number(text?.split("\n", 1)[0]);
          if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65_535)
            return candidate;
          yield* Effect.sleep(POLL_INTERVAL_MS);
        }
      }).pipe(
        Effect.raceFirst(
          Effect.flatMap(browser.exitCode, (code) =>
            Effect.fail(
              new HeliumError({
                message: `Helium exited with status ${code}`,
              }),
            ),
          ),
        ),
        Effect.timeoutOrElse({
          duration: START_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new HeliumError({
                message: `Helium did not expose a DevTools port within ${START_TIMEOUT_MS / 1000} seconds`,
              }),
            ),
        }),
      );
      return yield* Effect.gen(function* () {
        const response = yield* client.get(`http://127.0.0.1:${port}/json/version`);
        if (response.status < 200 || response.status >= 300)
          return yield* Effect.fail(
            new HeliumError({
              message: `Helium DevTools returned HTTP ${response.status}`,
            }),
          );
        const metadata = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(BrowserMetadata)),
          Effect.mapError(
            () =>
              new HeliumError({
                message: "Helium DevTools did not return a user agent",
              }),
          ),
        );
        return metadata["User-Agent"];
      }).pipe(Effect.timeout(START_TIMEOUT_MS));
    }),
  );
});

runMain(
  Effect.gen(function* () {
    const options = yield* Effect.try({
      try: () => parseArguments(Bun.argv.slice(2)),
      catch: (error) => error as HeliumError,
    });
    const launcher = yield* Effect.sync(() => Bun.which("helium-browser"));
    if (!launcher)
      return yield* Effect.fail(
        new HeliumError({
          message: "helium-browser is not installed or is missing from PATH",
        }),
      );
    const browserVersion = yield* readBrowserVersion(launcher);
    const cacheHome = yield* Config.String("XDG_CACHE_HOME").pipe(
      Config.withDefault(join(homedir(), ".cache")),
    );
    const cachePath = join(cacheHome || join(homedir(), ".cache"), CACHE_FILE_NAME);
    const cached = options.refresh
      ? undefined
      : yield* readCachedUserAgent(cachePath, browserVersion);
    if (cached) return yield* Console.log(cached);
    const userAgent = yield* probeUserAgent(launcher);
    yield* writeCachedUserAgent(cachePath, browserVersion, userAgent);
    yield* Console.log(userAgent);
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Console.error(
          `helium-user-agent: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      }),
    ),
  ),
);
