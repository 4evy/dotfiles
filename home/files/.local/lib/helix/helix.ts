#!/usr/bin/env bun
import { tmpdir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DiagnosticFilter, proxyLspServer } from "@dotfiles/runtime/lsp";
import { Effect, FileSystem, runMain } from "@dotfiles/runtime/runtime";

runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporaryDirectory = yield* fs.realPath(tmpdir());
    const isTemporaryUri = Effect.fn(function* (uri: unknown) {
      if (typeof uri !== "string") return false;
      const path = yield* Effect.try(() => fileURLToPath(uri)).pipe(Effect.option);
      if (path._tag === "None") return false;
      const document = (yield* fs.exists(path.value))
        ? yield* fs.realPath(path.value)
        : path.value;
      const difference = relative(temporaryDirectory, document);
      return (
        difference !== ".." && !difference.startsWith("../") && !isAbsolute(difference)
      );
    });
    const server = yield* Effect.sync(() => Bun.which("rumdl"));
    if (!server)
      return yield* Effect.fail(
        new Error("rumdl is not installed or is missing from PATH"),
      );
    const diagnostics = new DiagnosticFilter((uri) =>
      isTemporaryUri(uri).pipe(Effect.orElseSucceed(() => false)),
    );
    process.exitCode = yield* proxyLspServer(
      [server, "server"],
      diagnostics.observe,
      diagnostics.filter,
    );
  }),
);
