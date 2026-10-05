import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import {
  DAEMON_PTY_COLUMNS,
  DAEMON_PTY_ROWS,
  type DaemonOperation,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { Process } from "@oh-my-pi/pi-natives";
import { readTerminalRows } from "@oh-my-pi/pi-tui/tools/terminal-output";
import { Serial, withTimeout } from "@oh-my-pi/pi-utils/async";
import { acquireFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import xterm, { type Terminal } from "@oh-my-pi/pi-utils/vterm";
import { z } from "zod";
import {
  type ActionReceipt,
  type ActionRequest,
  actionReceiptSchema,
  actionRequestSchema,
  type JobLogs,
  type JobObservation,
  observeRequestSchema,
  receiptRequestSchema,
  type TerminationRequest,
  type TerminationResult,
  terminationMetadataSchema,
  terminationRequestSchema,
} from "../../../../dotfiles/dot_omp/agent/lib/helper/jobs";
import { atomicWrite, privateDirectory, privateRead } from "../state";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const recordSchema = z.strictObject({
  scopeId: z.string(),
  owner: z.string(),
  installationId: z.string(),
  receipt: actionReceiptSchema,
  termination: terminationMetadataSchema.optional(),
});
const mutationQueues = new Map<string, { serial: Serial; pending: number }>();

async function boundedRead<T>(work: Promise<T>, deadline: number): Promise<T> {
  return withTimeout(
    work,
    Math.max(1, deadline - Date.now()),
    "Terminal observation deadline reached",
  );
}

function processTree(root: Process): Process[] {
  const processes = [root];
  for (const current of processes) {
    processes.push(...current.children());
  }
  return processes;
}

async function durableWrite(
  path: string,
  value: unknown,
  directory: string,
): Promise<void> {
  await atomicWrite(path, JSON.stringify(value));
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function withJobLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const queue = mutationQueues.getOrInsertComputed(directory, () => ({
    serial: new Serial(),
    pending: 0,
  }));
  queue.pending++;
  try {
    return await queue.serial.run(async () => {
      await privateDirectory(directory);
      const path = join(directory, "mutation.lock");
      const file = await open(
        path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o077) !== 0
        )
          throw new Error("Unsafe job mutation lock");
      } finally {
        await file.close();
      }
      const signal = AbortSignal.timeout(15000);
      // The utility appends .lock, preserving the existing cross-process lock path
      const lock = await acquireFileLock(join(directory, "mutation"), {
        retries: 601,
        retryDelayMs: 25,
        signal,
      }).catch((error) => {
        if (signal.aborted)
          throw new Error("Job mutation is busy; no action was sent", { cause: error });
        throw error;
      });
      try {
        return await work();
      } finally {
        lock.release();
      }
    });
  } finally {
    if (--queue.pending === 0) mutationQueues.delete(directory);
  }
}

function writeTerminal(target: Terminal, data: Uint8Array): Promise<void> {
  return new Promise<void>((resolve) => target.write(data, resolve));
}

async function styledScreen(logs: JobLogs): Promise<void> {
  if (logs.terminalText === undefined) return;
  const initial = logs.terminalReplay?.terminalSize ??
    logs.terminalSize ?? { columns: DAEMON_PTY_COLUMNS, rows: DAEMON_PTY_ROWS };
  const options = {
    cols: initial.columns,
    rows: initial.rows,
    scrollback: 4096,
    allowProposedApi: true,
  };
  let terminal = new xterm.Terminal(options);
  try {
    const bytes = Buffer.from(logs.terminalText, "utf8");
    let offset = 0;
    for (const event of logs.terminalReplay?.events ?? []) {
      if (event.offset > bytes.length) break;
      if (event.offset > offset)
        await writeTerminal(terminal, bytes.subarray(offset, event.offset));
      if (event.reset && event.offset > 0) {
        terminal.dispose();
        terminal = new xterm.Terminal({
          ...options,
          cols: event.terminalSize.columns,
          rows: event.terminalSize.rows,
        });
      } else terminal.resize(event.terminalSize.columns, event.terminalSize.rows);
      offset = event.offset;
    }
    if (offset < bytes.length) await writeTerminal(terminal, bytes.subarray(offset));
    logs.terminalRows = readTerminalRows(
      terminal,
      terminal.buffer.active.viewportY,
      terminal.rows,
    );
    logs.terminalStyleRows = logs.terminalRows;
  } finally {
    terminal.dispose();
  }
}

export class JobActions {
  constructor(
    private readonly broker: DaemonBrokerClient,
    private readonly directory: string,
    private readonly scopeId: string,
    private readonly owner: string,
    private readonly installationId: string,
  ) {}

  async bind(name: string, nativeId?: string) {
    const response = await this.broker.request({ op: "describe", name });
    if (
      response.op !== "describe" ||
      response.daemon.owner !== this.owner ||
      (nativeId !== undefined && response.daemon.id !== nativeId)
    )
      throw new Error("Job identity or remote owner mismatch");
    return response.daemon;
  }

  private async jobDirectory(name: string, nativeId: string): Promise<string> {
    const root = join(this.directory, "actions");
    await privateDirectory(root);
    const directory = join(root, hash(JSON.stringify([name, nativeId])));
    await privateDirectory(directory);
    // Sync directory entries too, so a power loss cannot forget the no-replay fence
    for (const parent of [
      root,
      this.directory,
      dirname(this.directory),
      dirname(dirname(this.directory)),
    ]) {
      const handle = await open(parent, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return directory;
  }

  async mutate<T>(name: string, nativeId: string, work: () => Promise<T>): Promise<T> {
    return withJobLock(await this.jobDirectory(name, nativeId), async () => {
      await this.bind(name, nativeId);
      return work();
    });
  }

  async observe(input: z.input<typeof observeRequestSchema>): Promise<JobObservation> {
    const request = observeRequestSchema.parse(input);
    const firstReadDeadline = Date.now() + Math.max(1000, request.maxWaitMs);
    await boundedRead(this.bind(request.name, request.nativeId), firstReadDeadline);
    let deadline = firstReadDeadline;
    let changedAt = Date.now();
    let previous: JobObservation | undefined;
    for (;;) {
      // No follow request can wait for silence forever, including animated spinners
      const remaining = previous ? deadline : firstReadDeadline;
      const sample = (async () => {
        const logsResult = await this.broker.request({
          op: "logs",
          name: request.name,
          lines: 1000,
          head: false,
          follow: false,
          timeoutMs: 0,
          renderTerminalRows: false,
        });
        if (logsResult.op !== "logs")
          throw new Error("Unexpected broker screen response");
        return { logsResult, daemon: await this.bind(request.name, request.nativeId) };
      })();
      let captured: Awaited<typeof sample>;
      try {
        captured = await boundedRead(sample, remaining);
      } catch (error) {
        if (previous && Date.now() >= deadline) return { ...previous, settled: false };
        throw error;
      }
      const { logsResult, daemon } = captured;
      const logs: JobLogs = logsResult;
      await styledScreen(logs);
      const observedAt = Date.now();
      if (!previous) deadline = observedAt + request.maxWaitMs;
      // Include the captured replay, not a later describe/output cursor
      const screenVersion = hash(
        JSON.stringify([
          this.installationId,
          this.scopeId,
          request.name,
          request.nativeId,
          logs.cursor,
          logs.terminalSize,
          logs.terminalReplay,
          logs.terminalText,
          logs.text,
        ]),
      );
      if (previous?.screenVersion !== screenVersion) changedAt = observedAt;
      const settled = observedAt - changedAt >= request.settleMs;
      const current = { daemon, logs, screenVersion, settled, observedAt };
      if (settled || observedAt >= deadline) return current;
      previous = current;
      await delay(
        Math.min(
          25,
          deadline - observedAt,
          Math.max(1, request.settleMs - (observedAt - changedAt)),
        ),
      );
    }
  }

  private recordPath(directory: string, actionId: string): string {
    return join(directory, `${hash(actionId)}.json`);
  }

  private async readRecord(
    path: string,
    name: string,
    nativeId: string,
    actionId: string,
  ) {
    try {
      const record = recordSchema.parse(JSON.parse(await privateRead(path)));
      if (
        record.scopeId !== this.scopeId ||
        record.owner !== this.owner ||
        record.installationId !== this.installationId ||
        record.receipt.name !== name ||
        record.receipt.nativeId !== nativeId ||
        record.receipt.actionId !== actionId
      )
        throw new Error("Durable action receipt identity mismatch");
      return record;
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
  }

  async receipt(input: z.input<typeof receiptRequestSchema>): Promise<ActionReceipt> {
    const request = receiptRequestSchema.parse(input);
    const directory = await this.jobDirectory(request.name, request.nativeId);
    const record = await this.readRecord(
      this.recordPath(directory, request.actionId),
      request.name,
      request.nativeId,
      request.actionId,
    );
    // A retained receipt can be recovered even after the daemon was removed/replaced
    if (record) return record.receipt;
    await this.bind(request.name, request.nativeId);
    return { ...request, state: "not-sent", createdAt: Date.now() };
  }

  private async execute(
    request: {
      name: string;
      nativeId: string;
      actionId: string;
      settleMs: number;
      maxWaitMs: number;
      expectedScreenVersion?: string;
    },
    operation: DaemonOperation,
    termination?: TerminationResult["termination"],
  ): Promise<ActionReceipt> {
    const directory = await this.jobDirectory(request.name, request.nativeId);
    return withJobLock(directory, async () => {
      const path = this.recordPath(directory, request.actionId);
      const existing = await this.readRecord(
        path,
        request.name,
        request.nativeId,
        request.actionId,
      );
      if (existing) return existing.receipt;
      await this.bind(request.name, request.nativeId);
      const receipt: ActionReceipt = {
        name: request.name,
        nativeId: request.nativeId,
        actionId: request.actionId,
        state: "not-sent",
        createdAt: Date.now(),
      };
      const record = {
        scopeId: this.scopeId,
        owner: this.owner,
        installationId: this.installationId,
        receipt,
        termination,
      };
      await durableWrite(path, record, directory);
      if (termination)
        await durableWrite(
          join(directory, "termination.json"),
          { actionId: request.actionId },
          directory,
        );
      if (request.expectedScreenVersion !== undefined) {
        const screen = await this.observe({
          name: request.name,
          nativeId: request.nativeId,
          settleMs: 0,
          maxWaitMs: 0,
        });
        if (screen.screenVersion !== request.expectedScreenVersion) {
          Object.assign(receipt, screen, {
            error: "Screen changed; action was not sent",
          });
          await durableWrite(path, record, directory);
          return receipt;
        }
      }
      const daemon = termination
        ? await this.bind(request.name, request.nativeId)
        : undefined;
      const root = daemon?.pid === undefined ? null : Process.fromPid(daemon.pid);
      const tracked = root ? processTree(root) : [];
      // This write commits the no-replay fence before touching broker transport
      receipt.state = "sent-outcome-unknown";
      receipt.sentAt = Date.now();
      await durableWrite(path, record, directory);
      try {
        await this.broker.request(operation);
        if (termination) termination.brokerAccepted = true;
        const screen = await this.observe({
          name: request.name,
          nativeId: request.nativeId,
          settleMs: request.settleMs,
          maxWaitMs: request.maxWaitMs,
        });
        Object.assign(receipt, screen, { state: "processed" });
        if (termination)
          termination.leaderExited =
            screen.daemon.state === "exited" || screen.daemon.state === "failed";
        if (termination && tracked.length > 0)
          termination.trackedProcessesNoLongerObserved = tracked.every(
            (process) => process.status() === "exited",
          );
      } catch {
        // Transport failure cannot distinguish a broker rejection from a lost reply
        receipt.error =
          "Action outcome is uncertain; this action ID will never be sent again";
      }
      await durableWrite(path, record, directory);
      return receipt;
    });
  }

  async action(input: ActionRequest): Promise<ActionReceipt> {
    const request = actionRequestSchema.parse(input);
    return this.execute(request, {
      op: "send",
      name: request.name,
      data: request.data,
      resize: request.resize,
    });
  }

  async terminate(input: TerminationRequest): Promise<TerminationResult> {
    const request = terminationRequestSchema.parse(input);
    const termination: TerminationResult["termination"] = {
      kind: request.kind,
      requestedAt: Date.now(),
      brokerAccepted: false,
      leaderExited: false,
      childrenGone: "unknown",
    };
    const operation: DaemonOperation =
      request.kind === "stop"
        ? { op: "stop", name: request.name, timeoutMs: request.timeoutMs }
        : {
            op: "send",
            name: request.name,
            signal: request.kind === "interrupt" ? "SIGINT" : "SIGKILL",
          };
    const receipt = await this.execute(
      { ...request, settleMs: 100, maxWaitMs: 500 },
      operation,
      termination,
    );
    const directory = await this.jobDirectory(request.name, request.nativeId);
    const record = await this.readRecord(
      this.recordPath(directory, request.actionId),
      request.name,
      request.nativeId,
      request.actionId,
    );
    return { receipt, termination: record?.termination ?? termination };
  }

  async termination(
    name: string,
    nativeId: string,
  ): Promise<TerminationResult["termination"] | undefined> {
    const directory = await this.jobDirectory(name, nativeId);
    try {
      const { actionId } = receiptRequestSchema
        .pick({ actionId: true })
        .parse(JSON.parse(await privateRead(join(directory, "termination.json"))));
      const record = await this.readRecord(
        this.recordPath(directory, actionId),
        name,
        nativeId,
        actionId,
      );
      return record?.termination;
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
  }
}
