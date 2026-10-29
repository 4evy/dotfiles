#!/usr/bin/env bun
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Schema } from "effect";
import { downloadFile, FilePin } from "./source.ts";

runMain(
  Effect.gen(function* () {
    const [lock, name, destination, ...extra] = Bun.argv.slice(2);
    if (!lock || !name || !destination || extra.length) {
      console.error("Usage: bun download.ts LOCK NAME DESTINATION");
      process.exitCode = 2;
      return;
    }
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
