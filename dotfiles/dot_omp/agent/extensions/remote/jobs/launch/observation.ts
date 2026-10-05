import type { AgentToolUpdateCallback } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { assertIdentity, terminal } from "../broker";
import type { Gateway } from "../gateway";
import type { JobSession } from "../session";
import type { JobRecord, RemoteJobDetails, RunInput, Scope } from "../types";

export async function observeLaunch(
  session: JobSession,
  scope: Scope,
  client: Gateway,
  job: JobRecord,
  daemon: DaemonSnapshot,
  input: RunInput,
  waitMs: number,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<RemoteJobDetails>,
) {
  if (!input.ready && !terminal(daemon) && waitMs > 0) {
    if (onUpdate) {
      const initialScreen = job.pty && !input.raw;
      const initial = initialScreen
        ? await session.observe(scope, client, job, daemon, {}, signal)
        : await session.logs(scope, client, job, daemon);
      daemon = initial.daemon;
      onUpdate(
        session.result(scope, job, daemon, initial.logs, {
          screen: initialScreen,
          ...("screenVersion" in initial
            ? { screenVersion: initial.screenVersion, settled: initial.settled }
            : {}),
          raw: input.raw,
          compact: input.compact,
        }),
      );
    }
    const waited = await client.request(
      {
        op: "wait",
        name: job.name,
        for: "exit",
        timeoutMs: waitMs,
      },
      signal,
    );
    assertIdentity(job, waited.daemon);
    daemon = waited.daemon;
  }
  const screen = job.pty && !input.raw && !terminal(daemon);
  const view = screen
    ? await session.observe(scope, client, job, daemon, {}, signal)
    : await session.logs(scope, client, job, daemon);
  return { view, screen };
}
