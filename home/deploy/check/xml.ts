#!/usr/bin/env bun
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { runParser } from "@optique/core/facade";
import { multiple } from "@optique/core/modifiers";
import { argument } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
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
      const paths = runParser(
        multiple(argument(string({ metavar: "FILE" }))),
        "home/deploy/check/xml.ts",
        process.argv.slice(2),
        {
          help: { option: { names: ["-h", "--help"] }, onShow: process.exit },
          onError: process.exit,
        },
      );
      for (const path of paths) {
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
