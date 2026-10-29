import {
  ChildProcess,
  ChildProcessSpawner,
  Data,
  Effect,
  exitCode,
  Option,
  Schema,
  Stdio,
  Stream,
} from "@dotfiles/runtime/runtime";
import { isRecord } from "@dotfiles/runtime/validation";
import { RAL } from "vscode-jsonrpc/node";

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeObject = Schema.decodeUnknownOption(JsonObject);

function jsonObject(body: Buffer): Record<string, unknown> | undefined {
  try {
    return Option.getOrUndefined(
      decodeObject(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    );
  } catch {
    return undefined;
  }
}

export class DiagnosticFilter<E = never, R = never> {
  readonly #suppressUri: (uri: unknown) => Effect.Effect<boolean, E, R>;
  readonly #responses = new Map<string, unknown>([
    ["textDocument/diagnostic", { kind: "full", items: [] }],
  ]);
  readonly #requests = new Map<number | string, string>();

  constructor(
    suppressUri: (uri: unknown) => Effect.Effect<boolean, E, R>,
    workspace = false,
  ) {
    this.#suppressUri = suppressUri;
    if (workspace) this.#responses.set("workspace/diagnostic", { items: [] });
  }

  observe = (body: Buffer) =>
    Effect.gen({ self: this }, function* () {
      const message = jsonObject(body);
      if (
        !message ||
        typeof message.method !== "string" ||
        !this.#responses.has(message.method)
      )
        return;
      if (typeof message.id !== "string" && typeof message.id !== "number") return;
      if (message.method === "textDocument/diagnostic") {
        const document = isRecord(message.params)
          ? message.params.textDocument
          : undefined;
        const uri = isRecord(document) ? document.uri : undefined;
        if (!(yield* this.#suppressUri(uri))) return;
      }
      this.#requests.set(message.id, message.method);
    });

  filter = (body: Buffer) =>
    Effect.gen({ self: this }, function* () {
      const message = jsonObject(body);
      if (!message) return body;
      if (message.method === "textDocument/publishDiagnostics") {
        if (
          !isRecord(message.params) ||
          !(yield* this.#suppressUri(message.params.uri))
        )
          return body;
        message.params = { ...message.params, diagnostics: [] };
      } else {
        if (typeof message.id !== "string" && typeof message.id !== "number")
          return body;
        const method = this.#requests.get(message.id);
        this.#requests.delete(message.id);
        if (!method || !("result" in message)) return body;
        message.result = this.#responses.get(method);
      }
      return Buffer.from(JSON.stringify(message));
    });
}

class LspError extends Data.TaggedError("LspError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
const protocolError = (cause: unknown) =>
  new LspError({ message: String(cause), cause });

// Only headers are normalized, body bytes stay opaque even for invalid JSON/UTF-8
function messageParser() {
  const buffer = RAL().messageBuffer.create("utf-8");
  let line = "";
  let headerLines = 0;
  let normalized = false;
  let length: number | undefined;
  let remaining = 0;
  return function* (chunk: Uint8Array | undefined): Generator<Buffer> {
    if (chunk === undefined) {
      if (length !== undefined || line || headerLines)
        throw new Error("LSP message ended before Content-Length bytes were read");
      return;
    }
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < bytes.length || length === 0) {
      if (length === undefined) {
        const newline = bytes.indexOf(10, offset);
        if (newline < 0) {
          line += bytes.subarray(offset).toString("ascii");
          break;
        }
        line += bytes.subarray(offset, newline).toString("ascii");
        offset = newline + 1;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line && headerLines) {
          buffer.append(normalized ? "\r\n" : "\r\n\r\n");
          const value = buffer.tryReadHeaders(true)?.get("content-length");
          if (value === undefined)
            throw new Error("LSP message is missing Content-Length");
          length = Number(value);
          remaining = length;
          headerLines = 0;
          normalized = false;
        } else {
          headerLines++;
          const colon = line.indexOf(":");
          // Historically unrelated malformed header lines are ignored
          if (colon >= 0) {
            const name = line.slice(0, colon).trim().toLowerCase();
            const value = line.slice(colon + 1).trim();
            if (
              name === "content-length" &&
              (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
            )
              throw new Error("Invalid LSP Content-Length");
            buffer.append(`${name}: ${value}\r\n`);
            normalized = true;
          }
        }
        line = "";
      } else {
        const count = Math.min(remaining, bytes.length - offset);
        if (count) buffer.append(bytes.subarray(offset, offset + count));
        offset += count;
        remaining -= count;
        const body = buffer.tryReadBody(length);
        if (body !== undefined) {
          length = undefined;
          yield Buffer.isBuffer(body)
            ? body
            : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
        }
      }
    }
  };
}

function messages<E, R>(chunks: Stream.Stream<Uint8Array, E, R>) {
  return Stream.suspend(() => {
    const parse = messageParser();
    return chunks.pipe(
      Stream.concat(Stream.make(undefined)),
      Stream.flatMap((chunk) =>
        Stream.unfold(parse(chunk), (iterator) =>
          Effect.try({
            try: () => {
              const next = iterator.next();
              return next.done ? undefined : ([next.value, iterator] as const);
            },
            catch: protocolError,
          }),
        ),
      ),
    );
  });
}

const frame = (body: Buffer) =>
  Stream.make(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body);

export const proxyLspServer = Effect.fn(function* <E, R>(
  argv: string[],
  observe: (body: Buffer) => Effect.Effect<void, E, R>,
  filter: (body: Buffer) => Effect.Effect<Buffer, E, R>,
) {
  const [command, ...args] = argv;
  if (command === undefined)
    return yield* Effect.fail(new Error("Expected an LSP server command"));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stdio = yield* Stdio.Stdio;
  // BunRuntime owns cancellation, these native callbacks only preserve LSP status
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const sigint = () => {
        process.exitCode = 130;
      };
      const sigterm = () => {
        process.exitCode = 143;
      };
      process.prependOnceListener("SIGINT", sigint);
      process.prependOnceListener("SIGTERM", sigterm);
      return { sigint, sigterm };
    }),
    ({ sigint, sigterm }) =>
      Effect.sync(() => {
        process.off("SIGINT", sigint);
        process.off("SIGTERM", sigterm);
      }),
  );
  const server = yield* spawner.spawn(
    ChildProcess.make(command, args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      forceKillAfter: 3000,
    }),
  );
  // Observe exit without failing the concurrent stdout drain on native signals
  const exited = exitCode(server).pipe(Effect.exit);
  const shutdown = Effect.sleep(3000).pipe(
    Effect.andThen(server.kill({ killSignal: "SIGKILL" })),
    Effect.ignore,
    Effect.forkScoped,
  );
  const input = messages(stdio.stdin).pipe(
    Stream.tap(observe),
    Stream.takeUntil((body) => jsonObject(body)?.method === "exit"),
    Stream.flatMap(frame),
    Stream.run(server.stdin),
    Effect.raceFirst(exited.pipe(Effect.asVoid)),
    Effect.ensuring(Effect.asVoid(shutdown)),
  );
  const output = messages(server.stdout).pipe(
    Stream.mapEffect(filter),
    Stream.flatMap(frame),
    Stream.run(stdio.stdout()),
    Effect.ensuring(Effect.asVoid(shutdown)),
  );
  const [, , result] = yield* Effect.all([input, output, exited], {
    concurrency: "unbounded",
  });
  return yield* result;
});
