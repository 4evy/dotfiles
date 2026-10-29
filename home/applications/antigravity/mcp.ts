import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";

type Message = {
  id?: string | number | null;
  method?: string;
  params?: { name?: string };
  result?: {
    instructions?: string;
    tools?: { name: string; description?: string }[];
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
  };
};

// Farstep uses dotted names, which Antigravity rejects even during discovery
const names = new Map<string, string>();
const requests = new Map<Message["id"], string>();
const [executable, ...args] = process.argv.slice(2);
if (!executable) throw new Error("Usage: mcp.ts COMMAND [ARG...]");
const upstream = spawn(executable, args, {
  stdio: ["pipe", "pipe", "inherit"],
});
const input = createInterface({ input: process.stdin });
const output = createInterface({ input: upstream.stdout });
const send = async (stream: Writable, message: Message) => {
  if (!stream.write(`${JSON.stringify(message)}\n`)) await once(stream, "drain");
};
const stop = () => upstream.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
upstream.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
upstream.stdin.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});
const exited = once(upstream, "exit");
void exited.then(() => {
  input.close();
  process.stdin.destroy();
});
try {
  await Promise.all([
    (async () => {
      for await (const line of input) {
        if (!line.trim()) continue;
        const message: Message = JSON.parse(line);
        if (message.id !== undefined && message.method)
          requests.set(message.id, message.method);
        if (message.method === "tools/call" && message.params?.name) {
          const original = names.get(message.params.name);
          if (original) message.params.name = original;
        }
        await send(upstream.stdin, message);
      }
      upstream.stdin.end();
    })(),
    (async () => {
      for await (const line of output) {
        if (!line.trim()) continue;
        const message: Message = JSON.parse(line);
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
              throw new Error(`MCP tool name collision: ${name}`);
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
          message.result?.structuredContent !== undefined &&
          !message.result.content?.length
        )
          message.result.content = [
            { type: "text", text: JSON.stringify(message.result.structuredContent) },
          ];
        await send(process.stdout, message);
      }
    })(),
  ]);
  const [code, signal] = await exited;
  process.exitCode = code ?? (signal ? 1 : 0);
} finally {
  stop();
  input.close();
  output.close();
}
