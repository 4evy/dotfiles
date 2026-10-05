import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { z as schemaZ } from "zod";
import { desktopInputSchema } from "../../../../lib/desktop/protocol";

export function createDesktopParameters(api: ExtensionAPI) {
  const z = api.zod;
  const desktopFields = {
    connection: z.string().min(1),
    timeout: z.number().min(1).max(120).optional(),
  };
  const desktopParameters = z.object({
    ...desktopFields,
    action: z.enum(["inspect", "open", "authorize", "release", "release-workspace"]),
    uri: z.string().optional(),
    source: z.enum(["monitor", "window"]).optional(),
    outputName: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  });
  const screenshotParameters = z
    .object({
      ...desktopFields,
      target: z.enum(["screen", "window"]).optional(),
      sessionId: z.string().min(1).optional(),
    })
    .strict();
  const inputParameters = desktopInputSchema.safeExtend({
    connection: schemaZ.string().min(1),
  });
  return { desktopParameters, screenshotParameters, inputParameters };
}
