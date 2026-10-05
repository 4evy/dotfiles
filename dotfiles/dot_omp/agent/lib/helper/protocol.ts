import { z } from "zod";

export const helperHandshakeSchema = z.strictObject({
  protocolMajor: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u),
  installationId: z.uuid(),
  platform: z.enum(["linux", "darwin"]),
  capabilities: z.array(z.string().min(1)),
});
export type HelperIdentity = z.infer<typeof helperHandshakeSchema>;

export function structuredResult(result: {
  isError?: boolean | undefined;
  structuredContent?: unknown;
}): unknown {
  if (result.structuredContent === undefined) {
    throw new Error(
      result.isError
        ? "Helper operation failed without structured metadata"
        : "Helper omitted structured metadata",
    );
  }
  return result.structuredContent;
}
