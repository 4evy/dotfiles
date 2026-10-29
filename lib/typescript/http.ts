import { Effect, type Scope } from "effect";
import { HttpClient, type HttpClientResponse } from "effect/http";
import { DotfilesError } from "./errors.ts";

// Consume inside the request scope so failures and interruption release the body
export function download<A, E, R>(
  url: string,
  consume: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | DotfilesError,
  Exclude<R, Scope.Scope> | HttpClient.HttpClient
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        HttpClient.withScope,
      );
      const response = yield* client
        .get(url)
        .pipe(
          Effect.mapError(
            (cause) =>
              new DotfilesError(`Download failed: ${url}: ${cause.message}`, { cause }),
          ),
        );
      return yield* consume(response);
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "120 seconds",
      orElse: () =>
        Effect.fail(new DotfilesError(`Download timed out after 120 seconds: ${url}`)),
    }),
  );
}
