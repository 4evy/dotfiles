import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { GUIDE_TOPICS } from "./guides";

export function createSkylightParameters(api: ExtensionAPI) {
  const z = api.zod;
  const guideParameters = z.object({
    topic: z
      .enum(GUIDE_TOPICS)
      .describe("Load just the guidance needed for the next step"),
  });
  const parameters = z.object({
    code: z
      .string()
      .optional()
      .describe("Computer-use JavaScript with top-level await"),
    title: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe("Short action or observation title shown in chat"),
    timeout_ms: z.number().int().positive().optional(),
    reset: z
      .boolean()
      .optional()
      .describe("Clear Skylight bindings before executing code"),
  });
  return { guideParameters, parameters };
}
