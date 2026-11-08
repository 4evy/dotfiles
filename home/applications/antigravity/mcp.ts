import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { exitCode } from "@dotfiles/runtime/process";
import { seq } from "@optique/core/constructs";
import { runParser } from "@optique/core/facade";
import { argument, passThrough } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { Effect, Schema, Stdio, Stream, Struct } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const TOOLS_CALL_METHOD = "tools/call";
const TOOL_NAMESPACE_SEPARATOR = ".";
const TOOL_NAME_SEPARATOR = "_";

const ToolSchema = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.String,
    description: Schema.optionalKey(Schema.String),
  }).mapFields(Struct.map(Schema.mutableKey)),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ContentSchema = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    text: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const MessageSchema = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
    method: Schema.optionalKey(Schema.String),
    params: Schema.optionalKey(
      Schema.StructWithRest(
        Schema.Struct({ name: Schema.optionalKey(Schema.String) }).mapFields(
          Struct.map(Schema.mutableKey),
        ),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
    result: Schema.optionalKey(
      Schema.StructWithRest(
        Schema.Struct({
          instructions: Schema.optionalKey(Schema.String),
          tools: Schema.optionalKey(Schema.Array(ToolSchema)),
          content: Schema.optionalKey(Schema.Unknown),
          structuredContent: Schema.optionalKey(Schema.Unknown),
        }).mapFields(Struct.map(Schema.mutableKey)),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

// JSON-RPC envelopes and nested MCP payloads retain fields not consumed here
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(MessageSchema));

type Message = typeof MessageSchema.Type;
type Tool = typeof ToolSchema.Type;
type Requests = Map<Message["id"], string>;

function messages<E, R>(stream: Stream.Stream<Uint8Array, E, R>) {
  return stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => Boolean(line.trim())),
    Stream.mapEffect((line) => decode(line)),
  );
}

function normalizeReferences(text: string) {
  return text.replace(/\b(?:helper|desktop|system)(?:\.[a-z_]+)+\b/g, (name) =>
    name.replaceAll(TOOL_NAMESPACE_SEPARATOR, TOOL_NAME_SEPARATOR),
  );
}

const normalizeTools = Effect.fn("normalizeTools")(function* (
  tools: readonly Tool[],
  names: Map<string, string>,
) {
  for (const tool of tools) {
    const name = tool.name.replaceAll(TOOL_NAMESPACE_SEPARATOR, TOOL_NAME_SEPARATOR);
    const previous = names.get(name);
    if (previous && previous !== tool.name)
      return yield* Effect.fail(new DotfilesError(`MCP tool name collision: ${name}`));
    names.set(name, tool.name);
    tool.name = name;
    if (tool.description) tool.description = normalizeReferences(tool.description);
  }
});

const normalizeResponse = Effect.fn("normalizeResponse")(function* (
  message: Message,
  requests: Requests,
  names: Map<string, string>,
) {
  const method = message.method ? undefined : requests.get(message.id);
  if (!message.method) requests.delete(message.id);
  if (method === "initialize" && message.result?.instructions)
    message.result.instructions = normalizeReferences(message.result.instructions);
  if (method === "tools/list" && message.result?.tools)
    yield* normalizeTools(message.result.tools, names);
  // Antigravity only exposes content blocks, not structured-only results
  if (method === TOOLS_CALL_METHOD && message.result?.structuredContent !== undefined) {
    const content = yield* Schema.decodeUnknownEffect(
      Schema.optional(Schema.Array(ContentSchema)),
    )(message.result.content);
    if (!content?.length)
      message.result.content = [
        {
          type: "text",
          text: JSON.stringify(message.result.structuredContent),
        },
      ];
  }
  return `${JSON.stringify(message)}\n`;
});

runMain(
  Effect.gen(function* () {
    const [executable, args] = runParser(
      seq(
        argument(string({ metavar: "COMMAND", pattern: /[\s\S]/ })),
        passThrough({ format: "greedy" }),
      ),
      "mcp.ts",
      process.argv.slice(2),
      {
        help: { option: { names: ["-h", "--help"] }, onShow: process.exit },
        stdout: console.error,
        onError: process.exit,
      },
    );
    const stdio = yield* Stdio.Stdio;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const upstream = yield* spawner.spawn(
      ChildProcess.make(executable, args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      }),
    );
    // Farstep uses dotted names, which Antigravity rejects even during discovery
    const names = new Map<string, string>();
    const requests: Requests = new Map();
    const encoder = new TextEncoder();
    const input = messages(stdio.stdin).pipe(
      Stream.map((message) => {
        if (message.id !== undefined && message.method)
          requests.set(message.id, message.method);
        if (message.method === TOOLS_CALL_METHOD && message.params?.name) {
          const original = names.get(message.params.name);
          if (original) message.params.name = original;
        }
        return encoder.encode(`${JSON.stringify(message)}\n`);
      }),
      Stream.run(upstream.stdin),
      Effect.catch((error) => {
        if (
          error._tag === "PlatformError" &&
          (error.reason.cause as NodeJS.ErrnoException | undefined)?.code === "EPIPE"
        )
          return Effect.void;
        return Effect.fail(error);
      }),
      Effect.andThen(Effect.never),
    );
    const output = messages(upstream.stdout).pipe(
      Stream.mapEffect((message) => normalizeResponse(message, requests, names)),
      Stream.run(stdio.stdout({ endOnDone: false })),
      Effect.andThen(exitCode(upstream)),
    );
    // Output drains before exit, while a closed child cancels blocked client input
    process.exitCode = yield* Effect.raceFirst(output, input);
  }),
);
