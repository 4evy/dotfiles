#!/usr/bin/env bun
const executable = Bun.which("solaar");
if (!executable) throw new Error("Solaar is not installed or is missing from PATH");

const solaar = Bun.spawn(
  [executable, "--window=hide", "--no-tray", ...process.argv.slice(2)],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
process.on("SIGINT", () => solaar.kill("SIGINT"));
process.on("SIGTERM", () => solaar.kill("SIGTERM"));
process.exitCode = await solaar.exited;
