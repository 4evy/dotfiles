import { Effect } from "effect";
import { DotfilesError } from "./errors.ts";

export function download(url: string): Effect.Effect<Response, DotfilesError> {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    },
    catch: (cause) =>
      new DotfilesError(
        `Download failed: ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      ),
  });
}
