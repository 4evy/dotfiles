import type { DaemonTerminalSize } from "@oh-my-pi/pi-tui/tools/daemon";
import type {
  JobReceipt,
  TerminationResult,
  TerminationStatus,
} from "../../../lib/helper/jobs";
import type { JobResultOptions } from "./output";

export function jobNotices(
  size: DaemonTerminalSize,
  showScreen: boolean | undefined,
  finishedAt: number | undefined,
  receipt: Omit<JobReceipt, "daemon" | "logs"> | undefined,
  termination: TerminationResult["termination"] | undefined,
  deadline: TerminationStatus["deadline"],
  options: JobResultOptions,
): string[] {
  return [
    ...(showScreen
      ? [
          `Screen ${size.columns}x${size.rows}${options.settled === undefined ? "" : options.settled ? " · settled" : " · still changing"}`,
        ]
      : []),
    ...(options.readyTimedOut ? ["Readiness wait ended without a match"] : []),
    ...(options.waitTimedOut ? ["Observation wait ended without new output"] : []),
    ...(options.matched !== undefined
      ? [`Log pattern matched: ${options.matched}`]
      : []),
    ...(receipt
      ? [
          `Action ${receipt.actionId}: ${receipt.state}${receipt.state === "processed" ? " (broker accepted; terminal observed, application consumption unproven)" : ""}`,
        ]
      : []),
    ...(termination
      ? [
          `Termination ${termination.kind}: leader ${termination.leaderExited ? "exited" : "not confirmed exited"}; children ${termination.childrenGone}`,
        ]
      : []),
    ...(deadline?.deadlineTriggeredAt !== undefined
      ? [
          `Deadline triggered at ${new Date(deadline.deadlineTriggeredAt).toISOString()}${deadline.forceSentAt === undefined ? "" : " · forced termination sent"} · children ${deadline.childrenGone}`,
        ]
      : []),
    ...(finishedAt !== undefined && options.deliveredAt !== undefined
      ? [
          `Finished at ${new Date(finishedAt).toISOString()} · delivered at ${new Date(options.deliveredAt).toISOString()} · delay ${Math.max(0, options.deliveredAt - finishedAt)} ms`,
        ]
      : []),
    ...(options.notice ? [options.notice] : []),
  ];
}
