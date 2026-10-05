import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type {
  JobReceipt,
  TerminationResult,
  TerminationStatus,
} from "../../../lib/helper/jobs";
import { terminal } from "./broker";
import { jobNotices } from "./presentation";
import { terminalSize } from "./terminal";
import type { JobRecord, Logs, Result } from "./types";

export interface JobResultOptions {
  notice?: string | undefined;
  readyTimedOut?: boolean | undefined;
  waitTimedOut?: boolean | undefined;
  matched?: string | undefined;
  markDelivered?: boolean | undefined;
  consume?: boolean | undefined;
  screen?: boolean | undefined;
  screenVersion?: string | undefined;
  settled?: boolean | undefined;
  receipt?: JobReceipt | undefined;
  raw?: boolean | undefined;
  compact?: boolean | undefined;
  styles?: boolean | undefined;
  finishedAt?: number | undefined;
  deliveredAt?: number | undefined;
  observedAt?: number | undefined;
  termination?: TerminationResult["termination"] | undefined;
  terminationStatus?: TerminationStatus | undefined;
  unreadCursor?: number | undefined;
  terminalRedraw?: boolean | undefined;
}

const redrawPattern =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: VT escape sequences identify terminal redraws
  /\u001b\[(?:\?(?:1049|1047|47)[hl]|[\d;]*[ABCDEFGHJKSTf])|\r(?!\n)/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: VT escape sequences leave the alternate screen
const leaveScreenPattern = /\u001b\[\?(?:1049|1047|47)l/gu;

export function hasTerminalRedraw(text: string): boolean {
  return redrawPattern.test(text);
}

export function publicReceipt(
  receipt: JobReceipt,
): Omit<JobReceipt, "daemon" | "logs"> {
  return {
    name: receipt.name,
    nativeId: receipt.nativeId,
    actionId: receipt.actionId,
    state: receipt.state,
    createdAt: receipt.createdAt,
    ...(receipt.sentAt !== undefined ? { sentAt: receipt.sentAt } : {}),
    ...(receipt.observedAt !== undefined ? { observedAt: receipt.observedAt } : {}),
    ...(receipt.screenVersion !== undefined
      ? { screenVersion: receipt.screenVersion }
      : {}),
    ...(receipt.settled !== undefined ? { settled: receipt.settled } : {}),
    ...(receipt.error !== undefined ? { error: sanitizeText(receipt.error) } : {}),
  };
}

function compactOutput(logs: Logs, redrawing: boolean): string {
  if (!redrawing) return logs.text;
  const raw = logs.rawText ?? logs.text;
  let restored = -1;
  for (const match of raw.matchAll(leaveScreenPattern))
    restored = match.index + match[0].length;
  if (restored >= 0)
    return (logs.outputGap ?? "") + sanitizeText(raw.slice(restored)).trim();
  if (!hasTerminalRedraw(raw)) return logs.text;
  return logs.outputGap ?? "";
}

function optionalFields<T extends object>(
  fields: T,
): {
  [Key in keyof T]?: Exclude<T[Key], undefined>;
} {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as { [Key in keyof T]?: Exclude<T[Key], undefined> };
}

function outputView(daemon: DaemonSnapshot, logs: Logs, options: JobResultOptions) {
  const compact = options.compact ?? true;
  const redrawing =
    options.terminalRedraw ?? hasTerminalRedraw(logs.rawText ?? logs.text);
  const showScreen =
    options.screen || (!terminal(daemon) && compact && redrawing && !options.raw);
  const styledRows = logs.terminalStyleRows ?? logs.terminalRows;
  const terminalRows = showScreen
    ? styledRows?.map((row) => Bun.stripANSI(row))
    : undefined;
  const terminalStyleRows = showScreen ? styledRows : undefined;
  const newOutput =
    compact && !options.raw ? compactOutput(logs, redrawing) : logs.text;
  const output = showScreen
    ? (options.styles === false ? terminalRows : terminalStyleRows)?.join("\n")
    : options.raw
      ? (logs.rawText ?? logs.text).replaceAll("\u001b", "\\x1b")
      : newOutput;
  return { compact, showScreen, newOutput, output, terminalRows, terminalStyleRows };
}

export function jobResult(
  code: number | undefined,
  job: JobRecord,
  daemon: DaemonSnapshot,
  logs: Logs,
  options: JobResultOptions = {},
): Result {
  const finished = terminal(daemon);
  const remoteState =
    code !== undefined ? "completed" : finished ? "unknown" : "running";
  const size = terminalSize(daemon);
  const view = outputView(daemon, logs, options);
  const finishedAt = options.finishedAt ?? daemon.exitedAt;
  const terminationStatus = options.terminationStatus ?? logs.terminationStatus;
  const termination = options.termination ?? terminationStatus?.termination;
  const deadline = terminationStatus?.deadline;
  const receipt = options.receipt ? publicReceipt(options.receipt) : undefined;
  const summary = `Job ${job.name} · ${daemon.state} · exit ${code ?? (finished ? "unknown" : "pending")} · cursor ${logs.cursor}`;
  const header = view.compact
    ? summary
    : `${summary}\nConnection ${job.connectionId} · ${job.cwd} · interpreter ${job.interpreter ?? job.spec.application} · lifetime ${daemon.persist ? "persist" : "session"}`;
  return {
    content: [
      {
        type: "text",
        text: [
          header,
          view.output || (view.showScreen ? "(empty screen)" : "(no new output)"),
          ...jobNotices(
            size,
            view.showScreen,
            finishedAt,
            receipt,
            termination,
            deadline,
            options,
          ),
        ].join("\n"),
      },
    ],
    details: {
      job: job.name,
      connectionId: job.connectionId,
      cwd: job.cwd,
      owner: job.owner,
      nativeId: job.nativeId,
      installationId: job.installationId,
      scopeId: job.scopeId,
      cursor: logs.cursor,
      unreadCursor: options.unreadCursor ?? logs.cursor,
      newOutput: view.newOutput,
      compact: view.compact,
      interpreter: job.interpreter ?? job.spec.application,
      ...optionalFields({
        rawOutput: options.raw ? (logs.rawText ?? logs.text) : undefined,
        replay: logs.replay ? true : undefined,
        termination,
        deadline,
        terminalColumns: job.pty ? size.columns : undefined,
        terminalHeight: job.pty ? size.rows : undefined,
        terminalRows: view.terminalRows,
        terminalStyleRows: view.terminalStyleRows,
        screenVersion: options.screenVersion,
        settled: options.settled,
        receipt,
        finishedAt,
        deliveredAt: options.deliveredAt,
        deliveryDelayMs:
          finishedAt !== undefined && options.deliveredAt !== undefined
            ? Math.max(0, options.deliveredAt - finishedAt)
            : undefined,
        observedAt: options.observedAt,
        remoteExitCode: code,
        exitCode: code,
        waitTimedOut: options.waitTimedOut,
        matched: options.matched,
      }),
      remoteState,
      state: daemon.state,
      lifetime: daemon.persist ? "persist" : "session",
      timeoutSeconds: job.timeoutSeconds,
      timeoutDisabled: job.timeoutSeconds === 0,
      wallTimeMs: Math.max(0, (daemon.exitedAt ?? Date.now()) - job.startedAt),
      service: {
        name: job.name,
        state: daemon.state,
        ready:
          daemon.readyAt !== undefined ||
          daemon.state === "ready" ||
          (!job.ready && daemon.state === "running"),
        timedOut: options.readyTimedOut ?? false,
        ...optionalFields({ pid: daemon.pid }),
      },
    },
    isError: code !== undefined ? code !== 0 : finished,
  };
}
