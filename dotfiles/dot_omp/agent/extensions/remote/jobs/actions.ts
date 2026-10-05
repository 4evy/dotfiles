import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { parseDaemonTerminalSize } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type { ActionReceipt, TerminationResult } from "../../../lib/helper/jobs";
import { assertIdentity, terminal } from "./broker";
import type { Gateway } from "./gateway";
import { publicReceipt } from "./output";
import type { JobSession } from "./session";
import { keyBytes, terminalSize } from "./terminal";
import {
  JOB_ACTIONS,
  type JobInput,
  type JobRecord,
  MAX_SEQUENCE_STEPS,
  type RemoteJobDetails,
  type Scope,
} from "./types";

type Settling = { settleMs: number | undefined; maxWaitMs: number };
type SendAction = (
  actionId: string,
  data?: string,
  resize?: { columns: number; rows: number },
  expectedScreenVersion?: string,
) => Promise<ActionReceipt>;
export interface ControlContext {
  session: JobSession;
  scope: Scope;
  input: JobInput;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  job: JobRecord;
  daemon: DaemonSnapshot;
  client: Gateway;
  name: string;
  settling: Settling;
  waitMs: number;
  act: SendAction;
}
export interface ControlEffects {
  client?: Gateway | undefined;
  daemon?: DaemonSnapshot | undefined;
  notice?: string | undefined;
  waitTimedOut?: boolean | undefined;
  matched?: string | undefined;
  receipt?: ActionReceipt | undefined;
  termination?: TerminationResult["termination"] | undefined;
  sequence?: RemoteJobDetails["sequence"];
}

async function inputAction(context: ControlContext): Promise<ControlEffects> {
  const { input, ctx, signal, job, client, name, act } = context;
  if (!job.pty) throw new Error(`${input.action} requires a managed remote PTY`);
  let data = input.data;
  if (input.action === "password" && data === undefined) {
    if (!ctx.hasUI) throw new Error("password requires data or an interactive UI");
    data = await ctx.ui.input(
      input.prompt ?? `Password (${job.connectionId}; Esc cancels): `,
      undefined,
      signal ? { signal } : undefined,
    );
    signal?.throwIfAborted();
    if (data === undefined) throw new Error("Password prompt cancelled");
  }
  if (input.action === "keys") {
    keyBytes(input.keys);
    const before = await client.observe(
      { name, nativeId: job.nativeId, settleMs: 0, maxWaitMs: 0 },
      signal,
    );
    assertIdentity(job, before.daemon);
    data = keyBytes(input.keys, before.logs.terminalText);
  }
  if (data === undefined) throw new Error(`${input.action} requires explicit data`);
  if (input.action === "reply" || input.action === "password") {
    if (/[\r\n\0]/u.test(data))
      throw new Error(`${input.action} data must not contain CR, LF, or NUL`);
    data = `${data}\r`;
  }
  const receipt = await act(
    input.actionId ?? randomUUID(),
    data,
    undefined,
    input.expectedScreenVersion,
  );
  const policy = JOB_ACTIONS[input.action];
  const notice = "notice" in policy ? policy.notice : undefined;
  return { notice, receipt };
}

async function sequenceAction(context: ControlContext): Promise<ControlEffects> {
  const { input, signal, job, name, settling, act } = context;
  let receipt: ActionReceipt | undefined;
  if (!job.pty) throw new Error("sequence requires a managed remote PTY");
  if (!input.steps?.length || input.steps.length > MAX_SEQUENCE_STEPS)
    throw new Error(`sequence requires 1–${MAX_SEQUENCE_STEPS} checked steps`);
  const checks = input.steps.map((step) => {
    keyBytes(step.keys);
    if (!step.expect) throw new Error("Each sequence step requires expect");
    return new RegExp(step.expect, "u");
  });
  const actionId = input.actionId ?? randomUUID();
  if (actionId.length > 100)
    throw new Error("Sequence actionId must be at most 100 characters");
  let expectedVersion = input.expectedScreenVersion;
  const sequence: NonNullable<RemoteJobDetails["sequence"]> = {
    actionId,
    receipts: [],
    completedSteps: 0,
  };
  for (const [index, step] of input.steps.entries()) {
    signal?.throwIfAborted();
    const before = await context.client.observe(
      { name, nativeId: job.nativeId, ...settling },
      signal,
    );
    assertIdentity(job, before.daemon);
    if (
      index > 0 &&
      (!before.settled ||
        !checks[index - 1]?.test(
          (before.logs.terminalRows ?? []).map((row) => Bun.stripANSI(row)).join("\n"),
        ))
    ) {
      sequence.error = `Screen changed before step ${index + 1}; subsequent keys were not sent`;
      break;
    }
    receipt = await act(
      `${actionId}:${index}`,
      keyBytes(step.keys, before.logs.terminalText),
      undefined,
      step.screenVersion ?? expectedVersion ?? before.screenVersion,
    );
    sequence.receipts.push(publicReceipt(receipt));
    if (receipt.state !== "processed" || !receipt.logs || !receipt.daemon) {
      sequence.error = `Step ${index + 1} was not observed as processed; subsequent keys were not sent`;
      break;
    }
    assertIdentity(job, receipt.daemon);
    const screen = (receipt.logs.terminalRows ?? [])
      .map((row) => Bun.stripANSI(row))
      .join("\n");
    if (!checks[index]?.test(screen)) {
      sequence.error = `Screen check failed after step ${index + 1}; subsequent keys were not sent`;
      break;
    }
    sequence.completedSteps++;
    expectedVersion = receipt.screenVersion;
    if (!receipt.settled && index + 1 < input.steps.length) {
      sequence.error = `Screen is still changing after step ${index + 1}; subsequent keys were not sent`;
      break;
    }
  }
  const notice = sequence.error ?? `Completed ${sequence.completedSteps} checked steps`;
  return { notice, receipt, sequence };
}

async function terminateAction(context: ControlContext): Promise<ControlEffects> {
  const {
    session,
    scope,
    input,
    signal,
    job,
    name,
    waitMs,
    client: initialClient,
  } = context;
  let receipt: ActionReceipt | undefined;
  let termination: TerminationResult["termination"] | undefined;
  let client = initialClient;
  const actionId = input.actionId ?? randomUUID();
  try {
    const stopped = await client.terminate(
      {
        name,
        nativeId: job.nativeId,
        actionId,
        kind: input.action === "force" ? "force" : "interrupt",
        timeoutMs: Math.min(waitMs || 2000, 10000),
      },
      signal,
    );
    receipt = stopped.receipt;
    termination = stopped.termination;
  } catch {
    try {
      client = await session.forRecord(scope, job);
      receipt = await client.receipt({ name, nativeId: job.nativeId, actionId });
    } catch {
      receipt = {
        name,
        nativeId: job.nativeId,
        actionId,
        state: "sent-outcome-unknown",
        createdAt: Date.now(),
        error: "Termination delivery is unknown; recover this receipt before retrying",
      };
    }
  }
  const notice =
    input.action === "force" ? "Requested forced stop" : "Requested interruption";
  return { notice, receipt, termination, client };
}

async function stopAction({
  session,
  scope,
  job,
  client,
  daemon,
}: ControlContext): Promise<ControlEffects> {
  return session.stop(scope, client, job, daemon);
}

async function modeAction(context: ControlContext): Promise<ControlEffects> {
  const { input, signal, job, client, name } = context;
  if (input.lifetime !== "session" && input.lifetime !== "persist")
    throw new Error("mode requires lifetime session or persist");
  const changed = await client.request(
    { op: "mode", name, mode: input.lifetime },
    signal,
  );
  assertIdentity(job, changed.daemon);
  const daemon = changed.daemon;
  const notice = `Lifetime: ${input.lifetime}`;
  return { notice, daemon };
}

async function waitAction(context: ControlContext): Promise<ControlEffects> {
  const { input, signal, job, client, name, waitMs } = context;
  let notice: string | undefined;
  const waited = await client.request(
    {
      op: "wait",
      name,
      for: "exit",
      timeoutMs: waitMs,
      ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
    },
    signal,
  );
  assertIdentity(job, waited.daemon);
  const daemon = waited.daemon;
  const waitTimedOut = waited.timedOut;
  const matched = waited.matched;
  if (input.pattern && matched === undefined && terminal(daemon))
    notice = "The remote process finished without observing the requested log pattern";
  return { notice, waitTimedOut, matched, daemon };
}

async function resizeAction(context: ControlContext): Promise<ControlEffects> {
  const { input, job, daemon, act } = context;
  if (!job.pty) throw new Error("resize requires a managed remote PTY");
  if (input.columns === undefined && input.rows === undefined)
    throw new Error("resize requires columns or rows");
  const size = terminalSize(daemon);
  const receipt = await act(
    input.actionId ?? randomUUID(),
    undefined,
    parseDaemonTerminalSize({
      columns: input.columns ?? size.columns,
      rows: input.rows ?? size.rows,
    }),
    input.expectedScreenVersion,
  );
  const notice = "Requested terminal resize";
  return { notice, receipt };
}

async function screenAction({ job }: ControlContext): Promise<ControlEffects> {
  if (!job.pty) throw new Error("screen requires a managed remote PTY");
  return {};
}

async function inspectAction(): Promise<ControlEffects> {
  return {};
}

export const ACTION_HANDLERS = {
  input: inputAction,
  reply: inputAction,
  password: inputAction,
  keys: inputAction,
  sequence: sequenceAction,
  interrupt: terminateAction,
  force: terminateAction,
  stop: stopAction,
  mode: modeAction,
  wait: waitAction,
  resize: resizeAction,
  screen: screenAction,
  status: inspectAction,
  logs: inspectAction,
} satisfies Record<
  Exclude<JobInput["action"], "list" | "receipt">,
  (context: ControlContext) => Promise<ControlEffects>
>;
