import { z } from "zod";
import type { Connection } from "../connections/types";
import { currentHelper } from "./plan";
import { remoteCommand } from "./platform";

export const helperStatusSchema = z
  .object({
    installed: z.boolean(),
    installationId: z.uuid().optional(),
    version: z.string().optional(),
    jobsReady: z.boolean().optional(),
  })
  .passthrough();
export type HelperStatus = z.infer<typeof helperStatusSchema>;

export async function helperStatus(
  connection: Connection,
  signal?: AbortSignal,
): Promise<HelperStatus> {
  if (connection.info.os !== "linux" && connection.info.os !== "macos")
    return {
      installed: false,
      jobsReady: false,
      reason: "omp-helper supports Linux and macOS jobs",
    };
  const output = await remoteCommand(
    connection,
    `if [ -x ${currentHelper} ]; then ${currentHelper} status; elif [ -x /run/current-system/sw/bin/omp-helper ]; then /run/current-system/sw/bin/omp-helper status; elif [ -x /usr/bin/omp-helper ]; then /usr/bin/omp-helper status; elif [ -x /opt/homebrew/bin/omp-helper ]; then /opt/homebrew/bin/omp-helper status; elif [ -x /usr/local/bin/omp-helper ]; then /usr/local/bin/omp-helper status; else printf '%s\\n' '{"installed":false,"jobsReady":false,"status":"not-installed"}'; fi`,
    signal,
  );
  return helperStatusSchema.parse(JSON.parse(output));
}
