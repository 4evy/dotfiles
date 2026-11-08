#!/usr/bin/env bun
import { DiagnosticFilter, proxyLspServer } from "@dotfiles/runtime/lsp";
import {
  ChildProcess,
  ChildProcessSpawner,
  Effect,
  exitCode,
  runMain,
} from "@dotfiles/runtime/runtime";

runMain(
  Effect.gen(function* () {
    const server = yield* Effect.sync(() => Bun.which("just-lsp"));
    if (!server)
      return yield* Effect.fail(
        new Error("just-lsp is not installed or is missing from PATH"),
      );
    const args = Bun.argv.slice(2);
    if (args.length) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(server, args, {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          forceKillAfter: 3000,
        }),
      );
      process.exitCode = yield* exitCode(child);
    } else {
      // Imported Justfiles produce unreliable diagnostics in just-lsp
      const diagnostics = new DiagnosticFilter(() => Effect.succeed(true), true);
      process.exitCode = yield* proxyLspServer(
        [server],
        diagnostics.observe,
        diagnostics.filter,
      );
    }
  }),
);
