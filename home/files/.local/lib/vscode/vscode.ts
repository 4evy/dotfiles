#!/usr/bin/env bun
import { DiagnosticFilter, proxyLspServer } from "../typescript/lsp/lsp.ts";

const server = Bun.which("just-lsp");
if (!server) throw new Error("just-lsp is not installed or is missing from PATH");
const args = Bun.argv.slice(2);
if (args.length) {
  const process_ = Bun.spawn([server, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await process_.exited;
} else {
  // Imported Justfiles produce unreliable diagnostics in just-lsp
  const diagnostics = new DiagnosticFilter(() => true, true);
  process.exitCode = await proxyLspServer(
    [server],
    diagnostics.observe,
    diagnostics.filter,
  );
}
