import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
// The narrow async module keeps this Node-hosted service free of Bun-only imports
import { Serial } from "@oh-my-pi/pi-utils/async";
import { z } from "zod";
import {
  authorizeRequestSchema,
  authorizeResponseSchema,
  type DesktopFrame,
  desktopActionSchema,
  desktopInputSchema,
  inputResponseSchema,
  inspectResponseSchema,
  simpleResponseSchema,
} from "../../../lib/desktop/protocol";
import { parseCapture } from "../../../lib/helper/desktop";
import { connectNodeHelper, type NodeHelperConnection } from "../../../lib/helper/node";
import { structuredResult } from "../../../lib/helper/protocol";

const DESKTOP_METHODS = [
  "get_screenshot",
  "click",
  "move",
  "press_key",
  "type_text",
  "scroll",
  "drag",
  "drag_handle",
];

const config = z
  .object({
    OMP_SKY_HELPER_PATH: z.string().min(1),
    OMP_SKY_SESSION_DIR: z.string().min(1),
  })
  .parse(process.env);
const point = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
const screenshotOptionsSchema = authorizeRequestSchema.pick({ outputName: true });
const requestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("setup") }),
  z.strictObject({ type: z.literal("release_input") }),
  z.strictObject({
    type: z.literal("execute"),
    method: z.enum([
      "get_screenshot",
      "click",
      "move",
      "press_key",
      "type_text",
      "scroll",
      "drag",
    ]),
    args: z.array(z.unknown()).max(1),
  }),
  z.strictObject({
    type: z.literal("drag_start"),
    handle_id: z.string().min(1),
    point,
  }),
  z.strictObject({ type: z.literal("drag_move"), handle_id: z.string().min(1), point }),
  z.strictObject({ type: z.literal("drag_end"), handle_id: z.string().min(1) }),
]);
let connection: Promise<NodeHelperConnection> | undefined;
let sessionId: string | undefined;
let outputName: string | undefined;
let frame: DesktopFrame | undefined;
const serial = new Serial();

async function close() {
  const pending = connection;
  connection = undefined;
  sessionId = undefined;
  outputName = undefined;
  frame = undefined;
  const client = await pending?.catch(() => undefined);
  if (!client) return;
  try {
    simpleResponseSchema.parse(
      structuredResult(await client.call("desktop.release", {})),
    );
  } finally {
    await client.close();
  }
}

async function dispatch(input: unknown): Promise<unknown> {
  const request = requestSchema.parse(input);
  if (request.type === "release_input") return close();
  connection ??= connectNodeHelper(config.OMP_SKY_HELPER_PATH);
  try {
    const client = await connection;
    if (request.type === "setup") {
      const inspection = inspectResponseSchema.parse(
        structuredResult(await client.call("desktop.inspect", {})),
      );
      return {
        target: "linux",
        methods: DESKTOP_METHODS,
        inspection,
      };
    }
    if (request.type === "execute" && request.method === "get_screenshot") {
      const options = screenshotOptionsSchema.parse(request.args[0] ?? {});
      if (
        sessionId &&
        options.outputName !== undefined &&
        options.outputName !== outputName
      ) {
        throw new Error(
          "mapping-unavailable: reset Skylight before selecting a different outputName",
        );
      }
      if (!sessionId) {
        // Only exec-approved screenshot calls may request a combined control session
        const authorization = authorizeResponseSchema.parse(
          structuredResult(
            await client.call("desktop.authorize", {
              source: "monitor",
              ...options,
            }),
          ),
        );
        if (authorization.status === "error")
          throw new Error(`${authorization.code}: ${authorization.message}`);
        sessionId = authorization.sessionId;
        outputName = options.outputName;
      }
      const capture = parseCapture(await client.call("desktop.capture", { sessionId }));
      if (capture.metadata.status === "error" || !capture.image) {
        const error = capture.metadata;
        throw new Error(
          error.status === "error"
            ? `${error.code}: ${error.message}`
            : "Desktop omitted image",
        );
      }
      frame = capture.metadata.frame;
      const filepath = join(config.OMP_SKY_SESSION_DIR, `${randomUUID()}.png`);
      await writeFile(filepath, Buffer.from(capture.image.data, "base64"), {
        mode: 0o600,
        flag: "wx",
      });
      return [
        { filepath, data_url: `data:image/png;base64,${capture.image.data}`, ...frame },
      ];
    }
    if (!sessionId)
      throw new Error("authorization-required: capture and authorize before input");
    const action = desktopActionSchema.parse(
      request.type === "execute"
        ? { method: request.method, input: request.args[0] }
        : {
            method: request.type,
            input: {
              handle_id: request.handle_id,
              ...("point" in request ? { point: request.point } : {}),
            },
          },
    );
    const args = desktopInputSchema.parse({
      sessionId,
      ...(frame ? { frame: { streamId: frame.streamId, frameId: frame.frameId } } : {}),
      action,
    });
    const result = inputResponseSchema.parse(
      structuredResult(await client.call("desktop.input", args)),
    );
    if (action.method === "type_text" && result.receipt) {
      return {
        ...result.receipt,
        status: result.status,
        ...(result.status === "error"
          ? { code: result.code, message: result.message }
          : {}),
      };
    }
    if (result.status === "error") throw new Error(`${result.code}: ${result.message}`);
    return result;
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

export function handleRpc(input: unknown): Promise<unknown> {
  return serial.run(() => dispatch(input));
}
