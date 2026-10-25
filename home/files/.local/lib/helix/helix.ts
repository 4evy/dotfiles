#!/usr/bin/env bun
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DiagnosticFilter, proxyLspServer } from "../typescript/lsp/lsp.ts";

const temporaryDirectory = realpathSync(tmpdir());
function isTemporaryUri(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  try {
    const path = fileURLToPath(uri);
    const document = existsSync(path) ? realpathSync(path) : path;
    const difference = relative(temporaryDirectory, document);
    return (
      difference !== ".." && !difference.startsWith("../") && !isAbsolute(difference)
    );
  } catch {
    return false;
  }
}

const server = Bun.which("rumdl");
if (!server) throw new Error("rumdl is not installed or is missing from PATH");
const diagnostics = new DiagnosticFilter(isTemporaryUri);
process.exitCode = await proxyLspServer(
  [server, "server"],
  diagnostics.observe,
  diagnostics.filter,
);
