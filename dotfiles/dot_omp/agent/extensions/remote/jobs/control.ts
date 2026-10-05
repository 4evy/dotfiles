import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { JobObservation } from "../../../lib/helper/jobs";
import { ACTION_HANDLERS, type ControlContext, type ControlEffects } from "./actions";
import { assertIdentity, terminal } from "./broker";
import type { Gateway } from "./gateway";
import { publicReceipt } from "./output";
import type { JobSession } from "./session";
import {
  JOB_ACTIONS,
  type JobInput,
  type LaunchRecord,
  type Result,
  type Scope,
} from "./types";
import { lineCount, number, regex, seconds } from "./validation";

async function listJobs(
  session: JobSession,
  scope: Scope,
  signal?: AbortSignal,
): Promise<Result> {
  const jobs = [];
  for (const record of scope.branch.values()) {
    try {
      const client = await session.forRecord(scope, record);
      const { job, daemon } = await session.inspect(scope, client, record, signal);
      jobs.push({
        job: job.name,
        state: daemon.state,
        exitCode: daemon.exitCode ?? null,
        connection: job.connectionId,
        lifetime: daemon.persist ? "persist" : "session",
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      jobs.push({
        job: record.name,
        state: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ jobs }) }],
    details: {},
    isError: false,
  };
}

async function recoverReceipt(
  client: Gateway,
  record: LaunchRecord,
  input: JobInput,
  signal?: AbortSignal,
): Promise<Result> {
  const name = record.name;
  if (!input.actionId) throw new Error("receipt requires actionId");
  if (!record.nativeId)
    throw new Error(
      "The launch has no confirmed native identity; inspect its status before receipt recovery",
    );
  const receipt = await client.receipt(
    {
      name,
      nativeId: record.nativeId,
      actionId: input.actionId,
    },
    signal,
  );
  const safeReceipt = publicReceipt(receipt);
  const styledRows = receipt.logs?.terminalStyleRows ?? receipt.logs?.terminalRows;
  const terminalRows = styledRows?.map((row) => Bun.stripANSI(row));
  return {
    content: [
      {
        type: "text",
        text: [
          `Job ${name} · action ${receipt.actionId}: ${receipt.state}`,
          "Recovered historical receipt; no input was resent. Current process state was not inferred",
          ...(receipt.screenVersion
            ? [
                `Observed screen ${receipt.screenVersion}${receipt.settled ? " · settled" : " · still changing"}`,
              ]
            : []),
          ...(styledRows ? [styledRows.join("\n")] : []),
          ...(safeReceipt.error ? [safeReceipt.error] : []),
        ].join("\n"),
      },
    ],
    details: {
      job: name,
      connectionId: record.connectionId,
      receipt: safeReceipt,
      remoteState: "unknown",
      newOutput: "",
      screenVersion: receipt.screenVersion,
      settled: receipt.settled,
      terminalRows,
      terminalStyleRows: styledRows,
      observedAt: receipt.observedAt,
      cursor: receipt.logs?.cursor,
    },
    isError: receipt.state !== "processed",
  };
}

async function renderControlResult(
  context: ControlContext,
  effects: ControlEffects,
  lines: number,
): Promise<Result> {
  const { session, scope, job, input, signal, name, settling, waitMs } = context;
  let { daemon, client } = context;
  let observation: JobObservation | undefined;
  daemon = effects.daemon ?? daemon;
  client = effects.client ?? client;
  const { notice, waitTimedOut, matched, receipt, termination, sequence } = effects;
  if (receipt) {
    if (receipt.daemon) {
      assertIdentity(job, receipt.daemon);
      daemon = receipt.daemon;
    }
    if (receipt.logs && receipt.daemon && receipt.screenVersion !== undefined) {
      const unread = await session.logs(
        scope,
        client,
        job,
        receipt.daemon,
        {
          screenLogs: receipt.logs,
        },
        signal,
      );
      observation = {
        ...unread,
        screenVersion: receipt.screenVersion,
        settled: receipt.settled ?? false,
        observedAt: receipt.observedAt ?? Date.now(),
      };
    }
    if (receipt.state !== "processed" && !observation) {
      const safeReceipt = publicReceipt(receipt);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              job: name,
              state: daemon.state,
              exitCode: daemon.exitCode ?? null,
              newOutput: "",
              cursor: session.delivery(scope, job).outputCursor ?? 0,
              receipt: safeReceipt,
              notice: safeReceipt.error ?? notice,
              ...(sequence ? { sequence } : {}),
            }),
          },
        ],
        details: {
          job: name,
          connectionId: job.connectionId,
          receipt: safeReceipt,
          remoteState: "unknown",
          ...(sequence ? { sequence } : {}),
        },
        isError: true,
      };
    }
  }
  const screen = job.pty && !input.raw && !terminal(daemon) && input.action !== "logs";
  if (screen && !observation)
    observation = await session.observe(scope, client, job, daemon, settling, signal);
  const unread =
    !screen || input.raw
      ? await session.logs(
          scope,
          client,
          job,
          daemon,
          {
            lines,
            cursor: input.cursor,
            follow: input.action === "logs" && waitMs > 0,
            timeoutMs: input.action === "logs" ? waitMs : 0,
          },
          signal,
        )
      : undefined;
  const view = unread ?? observation;
  if (!view) throw new Error("Job observation is unavailable");
  const result = session.result(scope, job, view.daemon, view.logs, {
    notice,
    waitTimedOut,
    matched,
    markDelivered: true,
    screen,
    ...(observation
      ? { screenVersion: observation.screenVersion, settled: observation.settled }
      : {}),
    receipt,
    termination,
    raw: input.raw,
    compact: input.compact,
  });
  if (sequence) {
    result.details = { ...result.details, sequence };
    result.isError ||= sequence.error !== undefined;
  }
  result.isError ||= receipt !== undefined && receipt.state !== "processed";
  return result;
}

export async function controlJob(
  session: JobSession,
  input: JobInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<Result> {
  const scope = session.current(ctx);
  const waitMs = seconds(
    input.waitSeconds,
    JOB_ACTIONS[input.action].waitSeconds,
    "waitSeconds",
  );
  const lines = lineCount(input.lines);
  if (
    input.cursor !== undefined &&
    (!number(input.cursor) || !Number.isInteger(input.cursor))
  )
    throw new Error("cursor must be a nonnegative integer");
  regex(input.pattern);
  const settling = {
    settleMs: input.settleMs,
    maxWaitMs:
      input.maxWaitMs ??
      (input.waitSeconds === undefined ? 500 : Math.min(waitMs, 5000)),
  };
  signal?.throwIfAborted();
  if (input.action === "list") return listJobs(session, scope, signal);
  if (!input.job) throw new Error(`${input.action} requires job`);
  const name = input.job;
  const record = scope.branch.get(name);
  if (!record)
    throw new Error(
      `Job ${name} is not managed by this remote owner on the current branch`,
    );
  let client = await session.forRecord(scope, record);
  if (input.action === "receipt") return recoverReceipt(client, record, input, signal);
  const finish = session.begin(scope, name);
  try {
    const { job, daemon } = await session.inspect(scope, client, record, signal);
    const act = async (
      actionId: string,
      data?: string,
      resize?: { columns: number; rows: number },
      expectedScreenVersion?: string,
    ) => {
      try {
        return await client.action(
          {
            name,
            nativeId: job.nativeId,
            actionId,
            ...(data !== undefined ? { data } : {}),
            ...(resize ? { resize } : {}),
            ...(expectedScreenVersion !== undefined ? { expectedScreenVersion } : {}),
            ...settling,
          },
          signal,
        );
      } catch {
        // Receipt lookup is safe after transport loss; input is never replayed
        try {
          client = await session.forRecord(scope, job);
          return await client.receipt({ name, nativeId: job.nativeId, actionId });
        } catch {
          return {
            actionId,
            name,
            nativeId: job.nativeId,
            state: "sent-outcome-unknown" as const,
            createdAt: Date.now(),
            error:
              "Transport lost; delivery is unknown. Reconnect and recover this actionId before deciding whether to send a new action",
          };
        }
      }
    };
    const context: ControlContext = {
      session,
      scope,
      input,
      ctx,
      signal,
      job,
      daemon,
      get client() {
        return client;
      },
      name,
      settling,
      waitMs,
      act,
    };
    const effects = await ACTION_HANDLERS[input.action](context);
    return await renderControlResult(context, effects, lines);
  } finally {
    finish();
  }
}
