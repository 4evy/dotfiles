#!/usr/bin/env bun
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { seq } from "@optique/core/constructs";
import { runParser } from "@optique/core/facade";
import { argument } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { Effect, FileSystem, Schema } from "effect";
import { downloadFile, FilePin } from "./source.ts";

const [lock, name, destination] = runParser(
  seq(
    argument(string({ metavar: "LOCK", pattern: /[\s\S]/ })),
    argument(string({ metavar: "NAME", pattern: /[\s\S]/ })),
    argument(string({ metavar: "DESTINATION", pattern: /[\s\S]/ })),
  ),
  "download.ts",
  Bun.argv.slice(2),
  {
    help: { option: { names: ["-h", "--help"] }, onShow: process.exit },
    onError: () => process.exit(2),
  },
);

runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Inventories also contain Git pins, validate only the requested download
    const data = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({ pins: Schema.Record(Schema.String, Schema.Unknown) }),
      ),
    )(yield* fs.readFileString(lock));
    const pin = data.pins[name];
    if (pin === undefined)
      return yield* Effect.fail(
        new DotfilesError(`Source lock has no pin named ${name}`),
      );
    yield* downloadFile(yield* Schema.decodeUnknownEffect(FilePin)(pin), destination);
  }),
);
