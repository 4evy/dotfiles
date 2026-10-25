#!/usr/bin/env bun

import {
  mkdir,
  mkdtempDisposable,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 25;
const CACHE_FILE_NAME = "helium-user-agent.json";

type Options = {
  refresh: boolean;
};

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseArguments(arguments_: string[]): Options {
  if (arguments_.length === 0) return { refresh: false };
  if (arguments_.length === 1 && arguments_[0] === "--refresh") {
    return { refresh: true };
  }
  throw new Error("usage: helium-user-agent [--refresh]");
}

async function readBrowserVersion(launcher: string): Promise<string> {
  await using versionProcess = Bun.spawn([launcher, "--version"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    versionProcess.exited,
    new Response(versionProcess.stderr).text(),
    new Response(versionProcess.stdout).text(),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(`Helium version check failed${detail ? `: ${detail}` : ""}`);
  }

  const version = stdout.trim();
  if (!version) throw new Error("Helium version check returned no output");
  return version;
}

function userAgentCachePath(): string {
  const cacheHome = Bun.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, CACHE_FILE_NAME);
}

async function readCachedUserAgent(
  path: string,
  browserVersion: string,
): Promise<string | undefined> {
  try {
    const entry: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof entry === "object" &&
      entry !== null &&
      "browserVersion" in entry &&
      entry.browserVersion === browserVersion &&
      "userAgent" in entry &&
      typeof entry.userAgent === "string"
    ) {
      return entry.userAgent;
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT") && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
}

async function writeCachedUserAgent(
  path: string,
  browserVersion: string,
  userAgent: string,
): Promise<void> {
  const cacheDirectory = dirname(path);
  await mkdir(cacheDirectory, { recursive: true });
  await using temporary = await mkdtempDisposable(
    join(cacheDirectory, ".helium-user-agent-"),
  );
  const temporaryPath = join(temporary.path, CACHE_FILE_NAME);
  await writeFile(temporaryPath, `${JSON.stringify({ browserVersion, userAgent })}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function readDevToolsPort(
  profile: string,
  browser: Bun.Subprocess,
): Promise<number> {
  const activePort = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (browser.exitCode !== null) {
      throw new Error(`Helium exited with status ${browser.exitCode}`);
    }

    try {
      const [line] = (await readFile(activePort, "utf8")).split("\n", 1);
      const port = Number(line);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Helium did not expose a DevTools port within ${START_TIMEOUT_MS / 1000} seconds`,
  );
}

async function probeUserAgent(launcher: string): Promise<string> {
  await using profile = await mkdtempDisposable(join(tmpdir(), "helium-user-agent-"));
  await using browser = Bun.spawn(
    [
      launcher,
      `--user-data-dir=${profile.path}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-startup-window",
    ],
    { stderr: "ignore", stdout: "ignore" },
  );

  const port = await readDevToolsPort(profile.path, browser);
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(START_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Helium DevTools returned HTTP ${response.status}`);
  }

  const metadata: unknown = await response.json();
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("User-Agent" in metadata) ||
    typeof metadata["User-Agent"] !== "string"
  ) {
    throw new Error("Helium DevTools did not return a user agent");
  }
  return metadata["User-Agent"];
}

async function main(): Promise<void> {
  const options = parseArguments(Bun.argv.slice(2));
  const launcher = Bun.which("helium-browser");
  if (!launcher) {
    throw new Error("helium-browser is not installed or is missing from PATH");
  }

  const browserVersion = await readBrowserVersion(launcher);
  const cachePath = userAgentCachePath();
  const cached = options.refresh
    ? undefined
    : await readCachedUserAgent(cachePath, browserVersion);
  if (cached) {
    console.log(cached);
    return;
  }

  const userAgent = await probeUserAgent(launcher);
  await writeCachedUserAgent(cachePath, browserVersion, userAgent);
  console.log(userAgent);
}

try {
  await main();
} catch (error) {
  console.error(
    `helium-user-agent: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
