import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { DotfilesError } from "./errors.ts";

export function withTemporaryDirectory<A, E, R>(
  prefix: string,
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DotfilesError, R> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), prefix)),
      catch: (cause) =>
        new DotfilesError("Could not create temporary directory", { cause }),
    }),
    use,
    (directory) =>
      Effect.tryPromise({
        try: () => rm(directory, { recursive: true, force: true }),
        catch: (cause) =>
          new DotfilesError(`Could not remove temporary directory: ${directory}`, {
            cause,
          }),
      }),
  );
}
