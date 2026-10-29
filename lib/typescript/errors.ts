import { Data } from "effect";

export class DotfilesError extends Data.TaggedError("DotfilesError")<{
  message: string;
  cause?: unknown;
}> {
  constructor(message: string, options?: ErrorOptions) {
    super({ message, ...options });
  }
}

export class UsageError extends Data.TaggedError("UsageError")<{
  message: string;
  cause?: unknown;
}> {
  constructor(message: string, options?: ErrorOptions) {
    super({ message, ...options });
  }
}
