import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TOPICS } from "./topics";

export function createGuideParameters(api: ExtensionAPI) {
  const z = api.zod;
  const guideParameters = z.object({
    topic: z
      .enum(Object.keys(TOPICS) as [keyof typeof TOPICS, ...Array<keyof typeof TOPICS>])
      .optional()
      .describe("Load the topic needed for the next action"),
  });
  return { guideParameters };
}
