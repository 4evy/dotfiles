import { on } from "node:events";
import { constants } from "node:os";
import { Readable, Writable } from "node:stream";
import { type ContentTypeEncoder, RAL, StreamMessageWriter } from "vscode-jsonrpc/node";
import { isRecord } from "../validation.ts";

function jsonObject(body: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export class DiagnosticFilter {
  readonly #suppressUri: (uri: unknown) => boolean;
  readonly #responses = new Map<string, unknown>([
    ["textDocument/diagnostic", { kind: "full", items: [] }],
  ]);
  readonly #requests = new Map<number | string, string>();

  constructor(suppressUri: (uri: unknown) => boolean, workspace = false) {
    this.#suppressUri = suppressUri;
    if (workspace) this.#responses.set("workspace/diagnostic", { items: [] });
  }

  observe = (body: Buffer): void => {
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
      if (!this.#suppressUri(uri)) return;
    }
    this.#requests.set(message.id, message.method);
  };

  filter = (body: Buffer): Buffer => {
    const message = jsonObject(body);
    if (!message) return body;
    if (message.method === "textDocument/publishDiagnostics") {
      if (!isRecord(message.params) || !this.#suppressUri(message.params.uri))
        return body;
      message.params.diagnostics = [];
    } else {
      if (typeof message.id !== "string" && typeof message.id !== "number") return body;
      const method = this.#requests.get(message.id);
      this.#requests.delete(message.id);
      if (!method || !("result" in message)) return body;
      message.result = this.#responses.get(method);
    }
    return Buffer.from(JSON.stringify(message));
  };
}

const rawBody = Symbol("LSP body");

// Leave JSON and invalid UTF-8 opaque unless the diagnostic filter changes them
const rawEncoder: ContentTypeEncoder = {
  name: "application/json",
  async encode(message) {
    if (!(rawBody in message) || !Buffer.isBuffer(message[rawBody]))
      throw new Error("LSP message is missing its raw body");
    return message[rawBody];
  },
};

async function* readLspMessages(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<Buffer> {
  const buffer = RAL().messageBuffer.create("utf-8");
  let line = "";
  let headerLines = 0;
  let normalized = false;
  let length: number | undefined;
  let remaining = 0;
  for await (const chunk of chunks) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < bytes.length || length === 0) {
      if (length === undefined) {
        // Normalize only header lines; native MessageBuffer owns header parsing
        // and fragmented body storage, without inspecting or copying body text
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
  }
  if (length !== undefined || line || headerLines)
    throw new Error("LSP message ended before Content-Length bytes were read");
}

function sinkStream(sink: Bun.FileSink): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        sink.write(chunk);
        Promise.resolve(sink.flush()).then(() => callback(), callback);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

async function* inputChunks(signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const events = on(process.stdin, "data", {
    signal,
    close: ["end"],
    highWaterMark: 16,
    lowWaterMark: 8,
  });
  process.stdin.resume();
  for await (const [chunk] of events) {
    if (!(chunk instanceof Uint8Array)) throw new Error("LSP input must contain bytes");
    yield chunk;
  }
}

export async function proxyLspServer(
  argv: string[],
  observe: (body: Buffer) => void,
  filter: (body: Buffer) => Buffer,
): Promise<number> {
  const server = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const childInput = sinkStream(server.stdin);
  const childWriter = new StreamMessageWriter(childInput, {
    contentTypeEncoder: rawEncoder,
  });
  const outputWriter = new StreamMessageWriter(process.stdout, {
    contentTypeEncoder: rawEncoder,
  });
  let shutdownTimeout: NodeJS.Timeout | undefined;
  const shutdown = () => {
    if (shutdownTimeout !== undefined) return;
    shutdownTimeout = setTimeout(() => {
      if (server.exitCode === null) server.kill("SIGKILL");
    }, 3000);
    shutdownTimeout.unref();
  };
  const stop = () => {
    if (server.exitCode === null) server.kill("SIGTERM");
  };
  const interrupt = (signal: NodeJS.Signals) => {
    stop();
    shutdown();
    void server.exited.then(() => process.exit(128 + constants.signals[signal]));
  };
  const sigint = () => interrupt("SIGINT");
  const sigterm = () => interrupt("SIGTERM");
  process.on("exit", stop);
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  let inputError: unknown;
  const controller = new AbortController();
  const input = (async () => {
    try {
      for await (const body of readLspMessages(inputChunks(controller.signal))) {
        observe(body);
        const message = { jsonrpc: "2.0", [rawBody]: body };
        await childWriter.write(message);
        if (jsonObject(body)?.method === "exit") break;
      }
    } catch (error) {
      if (!controller.signal.aborted && server.exitCode === null) {
        inputError = error;
      }
    } finally {
      shutdown();
      server.stdin.end();
      process.stdin.pause();
    }
  })();
  try {
    for await (const body of readLspMessages(Readable.fromWeb(server.stdout))) {
      const message = { jsonrpc: "2.0", [rawBody]: filter(body) };
      await outputWriter.write(message);
    }
  } finally {
    controller.abort();
    process.stdin.destroy();
    await input;
    shutdown();
    try {
      await server.exited;
    } finally {
      clearTimeout(shutdownTimeout);
      childWriter.dispose();
      outputWriter.dispose();
      childInput.destroy();
      process.off("exit", stop);
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
    }
  }
  if (inputError) throw inputError;
  return await server.exited;
}
