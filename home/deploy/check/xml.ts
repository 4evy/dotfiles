#!/usr/bin/env bun
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem } from "effect";
import { SyntaxValidator } from "fast-xml-validator";

export function validateXML(contents: string): void {
  if (/<!ENTITY\s/i.test(contents))
    throw new Error("XML entity declarations are forbidden");
  SyntaxValidator.validate(contents, {
    invalidCharSequence: { comment: true, tagValue: true, attrLt: true },
  });
}

if (import.meta.main)
  runMain(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const path of process.argv.slice(2)) {
        yield* Effect.gen(function* () {
          const contents = yield* fs.readFileString(path);
          yield* Effect.try({
            try: () => validateXML(contents),
            catch: (error) => new DotfilesError(String(error)),
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              console.error(`${path}: ${error.message}`);
              process.exitCode = 1;
            }),
          ),
        );
      }
    }),
  );
