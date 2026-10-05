import { captureResponseSchema, validatePng } from "../desktop/protocol";
import { type HelperIdentity, structuredResult } from "./protocol";

const DESKTOP_CAPABILITIES = [
  "desktop",
  "bounded-png",
  "frame-bound-input",
  "text-receipts",
];

type ToolResult = {
  structuredContent?: unknown;
  isError?: boolean | undefined;
  content: Array<{ type: string; data?: unknown; mimeType?: unknown }>;
};

export function assertDesktopHelper(identity: HelperIdentity): void {
  const missing = DESKTOP_CAPABILITIES.filter(
    (capability) => !identity.capabilities.includes(capability),
  );
  if (missing.length)
    throw new Error(
      `Desktop helper lacks required protocol capabilities: ${missing.join(", ")}`,
    );
}

export function parseCapture(result: ToolResult) {
  const metadata = captureResponseSchema.parse(structuredResult(result));
  const images = result.content.filter((item) => item.type === "image");
  if (metadata.status === "error") {
    if (images.length !== 0)
      throw new Error("Failed capture unexpectedly contained image data");
    return { metadata };
  }
  const image = images[0];
  if (
    result.isError ||
    images.length !== 1 ||
    image?.mimeType !== "image/png" ||
    typeof image.data !== "string"
  ) {
    throw new Error("Desktop capture must return exactly one PNG image block");
  }
  validatePng(image.data, metadata.frame);
  return {
    metadata,
    image: { type: "image" as const, data: image.data, mimeType: "image/png" },
  };
}
