import type {
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type { Connection } from "../../connections/types";
import { terminal } from "../broker";
import type { JobSession } from "../session";
import { terminalSize } from "../terminal";
import type { JobRecord, RemoteJobDetails, Result, RunInput } from "../types";
import { observeLaunch } from "./observation";
import { prepareLaunch } from "./spec";

export async function runJob(
  session: JobSession,
  connection: Connection,
  input: RunInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<RemoteJobDetails>,
): Promise<Result> {
  const {
    scope,
    intent,
    size,
    waitMs,
    client: preparedClient,
  } = await prepareLaunch(session, connection, input, ctx, signal);
  let client = preparedClient;
  const { name, cwd, spec } = intent;
  // Persist before the irreversible start so a lost response can be inspected, never
  // replayed
  session.saveJob(scope, intent);
  const finish = session.begin(scope, name);
  let job: JobRecord | undefined;
  let daemon: DaemonSnapshot | undefined;
  let readyTimedOut = false;
  let termination: RemoteJobDetails["termination"];
  let receipt: RemoteJobDetails["receipt"];
  let notice: string | undefined;
  try {
    try {
      const started = await client.request(
        { op: "start", spec, owner: scope.owner, replace: false },
        signal,
      );
      daemon = started.daemon;
      readyTimedOut =
        started.readyTimedOut ||
        Boolean(input.ready && daemon.readyAt === undefined && terminal(daemon));
    } catch (error) {
      // Inspection is safe even when the start request failed after spawning
      notice = `The native start did not return a successful response: ${
        error instanceof Error ? error.message : String(error)
      }. The command was not retried`;
      client = await session.forRecord(scope, intent);
    }
    ({ job, daemon } = await session.inspect(scope, client, intent));
    if (size) {
      const actual = terminalSize(daemon);
      if (actual.columns !== size.columns || actual.rows !== size.rows)
        throw new Error(
          "Native broker did not apply the requested terminal dimensions",
        );
    }
    if (signal?.aborted) {
      const stopped = await session.stop(scope, client, job, daemon);
      daemon = stopped.daemon;
      termination = stopped.termination;
      receipt = stopped.receipt;
      notice = `Caller canceled the observation. ${stopped.notice}`;
    }
    const { view, screen } = await observeLaunch(
      session,
      scope,
      client,
      job,
      daemon,
      input,
      signal?.aborted ? 0 : waitMs,
      signal,
      onUpdate,
    );
    return session.result(scope, job, view.daemon, view.logs, {
      readyTimedOut,
      notice,
      markDelivered: true,
      termination,
      receipt,
      screen,
      ...("screenVersion" in view
        ? { screenVersion: view.screenVersion, settled: view.settled }
        : {}),
      raw: input.raw,
      compact: input.compact,
    });
  } catch (error) {
    if (job && signal?.aborted && session.isCurrent(scope)) {
      try {
        client = await session.forRecord(scope, job);
        const current = await session.inspect(scope, client, job);
        const stopped = await session.stop(scope, client, job, current.daemon);
        const view = await session.logs(scope, client, job, stopped.daemon);
        return session.result(scope, job, view.daemon, view.logs, {
          notice: `Caller canceled the observation. ${stopped.notice}`,
          markDelivered: true,
          termination: stopped.termination,
          receipt: stopped.receipt,
          raw: input.raw,
          compact: input.compact,
        });
      } catch {
        // A lost channel cannot establish remote cancellation or completion
      }
    }
    return {
      content: [
        {
          type: "text",
          text: `Job ${name}\n${notice ? `${notice}\n` : ""}${
            error instanceof Error ? error.message : String(error)
          }\nThe start was not retried. Remote outcome is unknown; inspect this exact handle with remote_job before any intentional new execution`,
        },
      ],
      details: {
        job: name,
        connectionId: connection.id,
        cwd,
        installationId: client.installationId,
        scopeId: scope.scopeId,
        remoteState: "unknown",
      },
      isError: true,
    };
  } finally {
    finish();
  }
}
