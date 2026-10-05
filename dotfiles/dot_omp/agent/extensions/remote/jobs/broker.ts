import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type { JobRecord } from "./types";

export function terminal(daemon: DaemonSnapshot): boolean {
  return daemon.state === "exited" || daemon.state === "failed";
}

export function assertIdentity(job: JobRecord, daemon: DaemonSnapshot): void {
  if (
    daemon.name !== job.name ||
    daemon.owner !== job.owner ||
    daemon.id !== job.nativeId ||
    daemon.startedAt !== job.startedAt ||
    daemon.createdAt !== job.nativeCreatedAt ||
    daemon.restartCount !== 0
  ) {
    throw new Error(
      `Native identity for ${
        job.name
      } changed; refusing to control a replaced or restarted process`,
    );
  }
}
