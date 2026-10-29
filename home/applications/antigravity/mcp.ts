import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { exitCode } from "@dotfiles/runtime/process";
import { Effect, Schema, Stdio, Stream, Struct } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const ToolSchema = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.String,
    description: Schema.optionalKey(Schema.String),
  }).mapFields(Struct.map(Schema.mutableKey)),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ContentSchema = Schema.StructWithRest(
  Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
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

const decode = Effect.fn("decodeMcpMessage")(function* (line: string) {
  const json = yield* Effect.try({
    try: () => JSON.parse(line) as unknown,
    catch: (error) => new DotfilesError(`Invalid MCP message: ${error}`),
  });
  // JSON-RPC envelopes and nested MCP payloads retain fields not consumed here
  return yield* Schema.decodeUnknownEffect(MessageSchema)(json);
});

runMain(
  Effect.gen(function* () {
    const [executable, ...args] = process.argv.slice(2);
    if (!executable)
      return yield* Effect.fail(new DotfilesError("Usage: mcp.ts COMMAND [ARG...]"));
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
    const requests = new Map<(typeof MessageSchema.Type)["id"], string>();
    const encoder = new TextEncoder();
    const input = stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => Boolean(line.trim())),
      Stream.mapEffect((line) =>
        Effect.gen(function* () {
          const message = yield* decode(line);
          if (message.id !== undefined && message.method)
            requests.set(message.id, message.method);
          if (message.method === "tools/call" && message.params?.name) {
            const original = names.get(message.params.name);
            if (original) message.params.name = original;
          }
          return encoder.encode(`${JSON.stringify(message)}\n`);
        }),
      ),
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
    const output = upstream.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => Boolean(line.trim())),
      Stream.mapEffect((line) =>
        Effect.gen(function* () {
          const message = yield* decode(line);
          const method = message.method ? undefined : requests.get(message.id);
          if (!message.method) requests.delete(message.id);
          if (method === "initialize" && message.result?.instructions)
            message.result.instructions = message.result.instructions.replace(
              /\b(?:helper|desktop|system)(?:\.[a-z_]+)+\b/g,
              (name) => name.replaceAll(".", "_"),
            );
          if (method === "tools/list" && message.result?.tools) {
            for (const tool of message.result.tools) {
              const name = tool.name.replaceAll(".", "_");
              const previous = names.get(name);
              if (previous && previous !== tool.name)
                return yield* Effect.fail(
                  new DotfilesError(`MCP tool name collision: ${name}`),
                );
              names.set(name, tool.name);
              tool.name = name;
              if (tool.description)
                tool.description = tool.description.replace(
                  /\b(?:helper|desktop|system)(?:\.[a-z_]+)+\b/g,
                  (name) => name.replaceAll(".", "_"),
                );
            }
          }
          // Antigravity only exposes content blocks, not structured-only results
          if (
            method === "tools/call" &&
            message.result?.structuredContent !== undefined
          ) {
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
        }),
      ),
      Stream.run(stdio.stdout({ endOnDone: false })),
      Effect.andThen(exitCode(upstream)),
    );
    // Output drains before exit, while a closed child cancels blocked client input
    process.exitCode = yield* Effect.raceFirst(output, input);
  }),
);
