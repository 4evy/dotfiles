import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { commandFields } from "../shell";

export function createSudoParameters(api: ExtensionAPI) {
  const z = api.zod;
  const sudoParameters = z.object({
    ...commandFields(api),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe("Positive privileged-command budget in seconds; default 60"),
    password: z
      .string()
      .optional()
      .describe("Plaintext password; omitted uses /etc/bleh or a normal text prompt"),
  });
  return { sudoParameters };
}
