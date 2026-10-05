import { z } from "zod";

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 46 * 1024 * 1024;

const id = z.string().min(1).max(1024);
const coordinate = z.number().finite();
const point = z.strictObject({ x: coordinate, y: coordinate });
const key = z.string().min(1).max(1024);
const duration = z.number().finite().nonnegative();
export const sourceSchema = z.enum(["monitor", "window"]);
export const textReceiptSchema = z.strictObject({
  mechanism: z.enum(["ei-text", "portal-clipboard", "data-control", "none"]),
  clipboardChanged: z.boolean(),
  submittedBytes: z.number().int().nonnegative(),
  partial: z.boolean(),
});
export const desktopActionSchema = z.discriminatedUnion("method", [
  z.strictObject({
    method: z.literal("click"),
    input: z.strictObject({
      x: coordinate,
      y: coordinate,
      click_count: z.number().int().positive().optional(),
      duration: duration.optional(),
      key: key.optional(),
      mouse_button: z.enum(["l", "r", "m", "left", "right", "middle"]).optional(),
    }),
  }),
  z.strictObject({
    method: z.literal("move"),
    input: z.strictObject({ x: coordinate, y: coordinate, key: key.optional() }),
  }),
  z.strictObject({
    method: z.literal("press_key"),
    input: z.strictObject({ key, duration: duration.optional() }),
  }),
  z.strictObject({
    method: z.literal("type_text"),
    input: z.strictObject({
      text: z
        .string()
        .refine((text) => !text.includes("\0"), "Text cannot contain NUL"),
      paste_key: key.optional(),
    }),
  }),
  z.strictObject({
    method: z.literal("scroll"),
    input: z
      .strictObject({
        direction: z.enum(["u", "d", "l", "r", "up", "down", "left", "right"]),
        pixels: z.number().finite().nonnegative().optional(),
        x: coordinate.optional(),
        y: coordinate.optional(),
        key: key.optional(),
      })
      .refine(
        (input) => (input.x === undefined) === (input.y === undefined),
        "Scroll origin requires both x and y",
      ),
  }),
  z.strictObject({
    method: z.literal("drag"),
    input: z.strictObject({ path: z.array(point).min(2), key: key.optional() }),
  }),
  z.strictObject({
    method: z.literal("drag_start"),
    input: z.strictObject({ handle_id: id, point }),
  }),
  z.strictObject({
    method: z.literal("drag_move"),
    input: z.strictObject({ handle_id: id, point }),
  }),
  z.strictObject({
    method: z.literal("drag_end"),
    input: z.strictObject({ handle_id: id }),
  }),
]);
export const frameReferenceSchema = z.strictObject({ streamId: id, frameId: id });
export const desktopInputSchema = z
  .strictObject({
    sessionId: id,
    frame: frameReferenceSchema.optional(),
    action: desktopActionSchema,
  })
  .refine(
    (input) =>
      ["press_key", "type_text"].includes(input.action.method) ||
      input.frame !== undefined,
    "Pointer input requires the latest frame identifiers",
  );
export const inspectRequestSchema = z.strictObject({});
export const openRequestSchema = z.strictObject({ uri: z.string().url().max(65536) });
export const authorizeRequestSchema = z.strictObject({
  source: sourceSchema,
  outputName: z.string().min(1).max(1024).optional(),
});
export const captureRequestSchema = z.strictObject({
  sessionId: id.optional(),
  source: sourceSchema.optional(),
});
export const releaseRequestSchema = z.strictObject({ sessionId: id.optional() });
export const workspaceReleaseRequestSchema = z.strictObject({ workspaceId: id });
export const frameSchema = z
  .strictObject({
    sessionId: id,
    streamId: id,
    frameId: id,
    source: sourceSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
    logicalGeometry: z
      .strictObject({
        x: coordinate,
        y: coordinate,
        width: z.number().positive().finite(),
        height: z.number().positive().finite(),
      })
      .nullable(),
    transform: z.number().int().min(0).max(7),
    mappingId: id.nullable(),
  })
  .refine(
    (frame) => frame.width * frame.height <= 100_000_000,
    "Capture exceeds pixel limit",
  );
export const desktopErrorSchema = z.strictObject({
  status: z.literal("error"),
  code: z.enum([
    "cancelled",
    "denied",
    "missing-protocol",
    "closed-session",
    "paused-device",
    "disconnected",
    "mapping-unavailable",
    "stale-frame",
    "partial-input",
    "authorization-required",
    "unsupported-text",
    "busy",
    "unsupported-platform",
    "invalid-request",
    "backend-error",
    "prerequisite",
  ]),
  message: z.string(),
  receipt: textReceiptSchema.optional(),
});
const ok = z.strictObject({ status: z.literal("ok") });
export const inspectResponseSchema = z.union([
  z.strictObject({
    status: z.literal("ok"),
    operations: z.array(
      z.strictObject({
        operation: z.enum(["capture", "keyboard", "pointer", "clipboard", "open"]),
        available: z.boolean(),
        requestable: z.boolean(),
        granted: z.boolean(),
        backend: z.string().nullable(),
        reason: z.string().nullable(),
      }),
    ),
    sources: z.array(sourceSchema),
    sessionId: id.nullable(),
  }),
  desktopErrorSchema,
]);
export const authorizeResponseSchema = z.union([
  z.strictObject({
    status: z.literal("ok"),
    sessionId: id,
    source: sourceSchema,
    backend: z.string(),
  }),
  desktopErrorSchema,
]);
export const captureResponseSchema = z.union([
  z.strictObject({ status: z.literal("ok"), frame: frameSchema }),
  desktopErrorSchema,
]);
export const inputResponseSchema = z.union([
  z.strictObject({ status: z.literal("ok"), receipt: textReceiptSchema.optional() }),
  desktopErrorSchema,
]);
export const simpleResponseSchema = z.union([ok, desktopErrorSchema]);
export const openResponseSchema = z.union([
  z.strictObject({ status: z.literal("ok"), workspaceId: id }),
  desktopErrorSchema,
]);
export type DesktopAction = z.infer<typeof desktopActionSchema>;
export type DesktopInputRequest = z.infer<typeof desktopInputSchema>;
export type DesktopFrame = z.infer<typeof frameSchema>;
export type TextReceipt = z.infer<typeof textReceiptSchema>;
export type DesktopError = z.infer<typeof desktopErrorSchema>;

export function validatePng(data: string, frame: DesktopFrame): void {
  if (
    data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)
  ) {
    throw new Error("Desktop returned invalid PNG encoding");
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const header = Buffer.from(data.slice(0, 44), "base64");
  if (
    (data.length / 4) * 3 - padding !== frame.bytes ||
    header.length < 33 ||
    !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    header.readUInt32BE(8) !== 13 ||
    header.toString("ascii", 12, 16) !== "IHDR" ||
    header.readUInt32BE(16) !== frame.width ||
    header.readUInt32BE(20) !== frame.height
  ) {
    throw new Error("Desktop returned mismatched PNG metadata");
  }
}
