import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
  DAEMON_OUTPUT_MAX_BYTES,
  parseDaemonSpec,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type {
  JobLogs,
  JobObservation,
  TerminationResult,
} from "../../../lib/helper/jobs";
import type { Connections } from "../connections/state";
import type { Connection } from "../connections/types";
import { assertIdentity, terminal } from "./broker";
import { deliverCompletion } from "./completion";
import { decodeOutput, type OutputRead } from "./decoding";
import { Gateway } from "./gateway";
import { type JobResultOptions, jobResult } from "./output";
import { ENTRY_TYPE, nativeKey, owner, recordInto, restoreScope } from "./records";
import type {
  DeliveryRecord,
  JobRecord,
  JobView,
  LaunchRecord,
  Logs,
  Result,
  Scope,
} from "./types";
import { DEFAULT_LINES } from "./validation";

export class JobSession {
  readonly #api: ExtensionAPI;
  readonly #connections: Connections;
  readonly #clients = new Map<string, Gateway>();
  readonly #routes = new Map<string, Promise<Gateway>>();
  readonly #outputReads = new WeakMap<Logs, OutputRead>();
  #scope: Scope | undefined;
  #closed = false;

  constructor(api: ExtensionAPI, connections: Connections) {
    this.#api = api;
    this.#connections = connections;
  }

  restore(ctx: ExtensionContext): void {
    this.#release();
    const scope = restoreScope(ctx);
    this.#scope = scope;
    const records = new Map<string, LaunchRecord>();
    for (const record of scope.all.values()) {
      if (
        !record.nativeId ||
        !scope.deliveries.get(
          nativeKey(record.installationId, record.scopeId, record.nativeId),
        )?.delivered
      )
        records.set(`${record.installationId}:${record.scopeId}`, record);
    }
    for (const record of records.values()) {
      void this.forRecord(scope, record).catch((error) => {
        if (!this.isCurrent(scope)) return;
        this.#api.sendMessage({
          customType: "remote-job-notice",
          content: `Remote completion subscription is unavailable: ${error instanceof Error ? error.message : String(error)}. Commands were not replayed; inspect ${record.name} with remote_job`,
          display: true,
        });
      });
    }
  }

  current(ctx: ExtensionContext): Scope {
    if (this.#closed) throw new Error("Remote job manager is closed");
    if (
      !this.#scope ||
      this.#scope.owner !== owner(ctx) ||
      this.#scope.ctx.cwd !== ctx.cwd
    )
      this.restore(ctx);
    if (!this.#scope) throw new Error("Remote job scope was not initialized");
    return this.#scope;
  }

  isCurrent(scope: Scope): boolean {
    return !this.#closed && this.#scope === scope;
  }

  assertCurrent(scope: Scope): void {
    if (!this.isCurrent(scope))
      throw new Error(
        "Remote session or branch changed; the command was not replayed. Inspect its exact handle with remote_job",
      );
  }

  async client(
    scope: Scope,
    connection: Connection,
    expectedInstallation?: string,
  ): Promise<Gateway> {
    this.assertCurrent(scope);
    const route = JSON.stringify([
      connection.target,
      connection.controlPath,
      scope.scopeId,
      scope.owner,
    ]);
    let pending = this.#routes.get(route);
    if (!pending) {
      pending = Gateway.connect(
        connection,
        scope.scopeId,
        scope.owner,
        (client, notification) =>
          deliverCompletion(this, this.#api, scope, client, notification),
        (closedClient) => {
          if (closedClient) {
            const key = `${closedClient.installationId}:${scope.scopeId}:${scope.owner}`;
            if (this.#clients.get(key) === closedClient) {
              this.#clients.delete(key);
              for (const [knownRoute, value] of this.#routes) {
                void value.then(
                  (client) => {
                    if (
                      client === closedClient &&
                      this.#routes.get(knownRoute) === value
                    )
                      this.#routes.delete(knownRoute);
                  },
                  () => {},
                );
              }
            }
          } else if (this.#routes.get(route) === pending) this.#routes.delete(route);
        },
      ).then(async (client) => {
        if (!this.isCurrent(scope)) {
          await client.close();
          throw new Error("Remote session changed during connection");
        }
        const key = `${client.installationId}:${scope.scopeId}:${scope.owner}`;
        const existing = this.#clients.get(key);
        if (existing) {
          await client.close();
          return existing;
        }
        this.#clients.set(key, client);
        return client;
      });
      this.#routes.set(route, pending);
      void pending.catch(() => {
        if (this.#routes.get(route) === pending) this.#routes.delete(route);
      });
    }
    const client = await pending;
    this.assertCurrent(scope);
    if (
      expectedInstallation !== undefined &&
      client.installationId !== expectedInstallation
    )
      throw new Error(
        "Connection now names a different helper installation; refusing job control",
      );
    return client;
  }

  forRecord(scope: Scope, record: LaunchRecord): Promise<Gateway> {
    if (
      record.scopeId !== scope.scopeId ||
      record.owner !== scope.owner ||
      record.projectDir !== scope.projectDir
    )
      throw new Error("Job belongs to a different immutable execution scope");
    return this.client(
      scope,
      this.#connections.selected(record.connectionId),
      record.installationId,
    );
  }

  begin(scope: Scope, name: string): () => void {
    const foreground = scope.foreground.getOrInsertComputed(name, () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      return { count: 0, done: promise, resolve };
    });
    foreground.count++;
    const current = foreground;
    return () => {
      if (--current.count === 0) {
        scope.foreground.delete(name);
        current.resolve();
      }
    };
  }

  saveJob(scope: Scope, record: LaunchRecord): void {
    this.assertCurrent(scope);
    recordInto(scope.all, record);
    recordInto(scope.branch, record);
    this.#api.appendEntry(ENTRY_TYPE, record);
  }

  delivery(scope: Scope, job: JobRecord): DeliveryRecord {
    const existing = scope.deliveries.get(
      nativeKey(job.installationId, job.scopeId, job.nativeId),
    );
    if (existing?.owner === job.owner && existing.name === job.name) return existing;
    return {
      version: 2,
      kind: "delivery",
      name: job.name,
      owner: job.owner,
      nativeId: job.nativeId,
      installationId: job.installationId,
      scopeId: job.scopeId,
      delivered: false,
    };
  }

  async inspect(
    scope: Scope,
    client: Gateway,
    record: LaunchRecord,
    signal?: AbortSignal,
  ): Promise<{ job: JobRecord; daemon: DaemonSnapshot }> {
    this.assertCurrent(scope);
    if (
      client.installationId !== record.installationId ||
      client.scopeId !== record.scopeId ||
      client.owner !== record.owner
    )
      throw new Error(
        `Job ${record.name} belongs to a different helper installation or scope`,
      );
    const described = await client.request(
      { op: "describe", name: record.name },
      signal,
    );
    this.assertCurrent(scope);
    const daemon = described.daemon;
    const expected = parseDaemonSpec(record.spec);
    // The broker updates lifetime and geometry without restarting the command
    const actual = {
      ...described.spec,
      persist: expected.persist,
      ...(expected.terminalSize ? { terminalSize: expected.terminalSize } : {}),
    };
    if (
      daemon.owner !== record.owner ||
      daemon.name !== record.name ||
      daemon.restartCount !== 0 ||
      !isDeepStrictEqual(actual, expected)
    )
      throw new Error(
        `Native identity or launch specification for ${record.name} changed; refusing control`,
      );
    const job: JobRecord =
      record.kind === "job"
        ? (record as JobRecord)
        : {
            ...record,
            kind: "job",
            nativeId: daemon.id,
            startedAt: daemon.startedAt,
            nativeCreatedAt: daemon.createdAt,
          };
    assertIdentity(job, daemon);
    if (record.kind === "launch") {
      recordInto(scope.all, job);
      if (scope.branch.has(job.name)) this.saveJob(scope, job);
    }
    return { job, daemon };
  }

  async logs(
    scope: Scope,
    client: Gateway,
    job: JobRecord,
    daemon: DaemonSnapshot,
    options: {
      lines?: number | undefined;
      cursor?: number | undefined;
      follow?: boolean | undefined;
      timeoutMs?: number | undefined;
      renderTerminalRows?: boolean | undefined;
      screenLogs?: JobLogs | undefined;
    } = {},
    signal?: AbortSignal,
  ): Promise<JobView> {
    this.assertCurrent(scope);
    let screenLogs = options.screenLogs;
    if (!screenLogs && options.renderTerminalRows) {
      screenLogs = await client.request(
        {
          op: "logs",
          name: job.name,
          lines: options.lines ?? DEFAULT_LINES,
          head: false,
          follow: options.follow ?? false,
          timeoutMs: options.timeoutMs ?? 0,
          renderTerminalRows: true,
        },
        signal,
      );
    }
    const requestedCursor =
      options.cursor ?? this.delivery(scope, job).outputCursor ?? 0;
    // A screen covers its whole byte range; retain a bounded raw tail alongside it
    const cursor = screenLogs
      ? Math.min(
          screenLogs.cursor,
          Math.max(requestedCursor, screenLogs.cursor - DAEMON_OUTPUT_MAX_BYTES),
        )
      : requestedCursor;
    let output = await client.request(
      {
        op: "output",
        name: job.name,
        cursor,
        follow: !screenLogs && (options.follow ?? false),
        timeoutMs: options.timeoutMs ?? 0,
      },
      signal,
    );
    this.assertCurrent(scope);
    if (
      !screenLogs &&
      options.cursor === undefined &&
      terminal(daemon) &&
      output.cursor < output.availableEnd
    ) {
      output = await client.request(
        {
          op: "output",
          name: job.name,
          cursor: Math.max(
            requestedCursor,
            output.availableEnd - DAEMON_OUTPUT_MAX_BYTES,
          ),
          follow: false,
          timeoutMs: 0,
        },
        signal,
      );
      this.assertCurrent(scope);
    }
    const end = screenLogs ? Math.min(output.cursor, screenLogs.cursor) : output.cursor;
    const bytes = Buffer.from(output.data, "base64").subarray(
      0,
      Math.max(0, end - output.startCursor),
    );
    const logs: Logs = {
      ...screenLogs,
      op: "logs",
      name: job.name,
      text: "",
      cursor: end,
      timedOut: screenLogs?.timedOut ?? output.timedOut,
      state: screenLogs?.state ?? output.state,
      ...(options.cursor !== undefined ? { replay: true } : {}),
    };
    this.#outputReads.set(logs, {
      bytes,
      startCursor: output.startCursor,
      cursor: end,
      availableEnd: output.availableEnd,
      availableStart: output.availableStart,
      requestedCursor,
      replay: options.cursor !== undefined,
      lines: options.lines ?? DEFAULT_LINES,
    });
    if (!screenLogs) ({ daemon } = await this.inspect(scope, client, job, signal));
    assertIdentity(job, daemon);
    logs.terminationStatus = await client.termination(
      { name: job.name, nativeId: job.nativeId },
      signal,
    );
    this.assertCurrent(scope);
    const decoded = this.#decode(scope, job, daemon, logs);
    Object.assign(logs, decoded.logs);
    return { daemon, logs };
  }

  async observe(
    scope: Scope,
    client: Gateway,
    job: JobRecord,
    _daemon: DaemonSnapshot,
    options: { settleMs?: number | undefined; maxWaitMs?: number | undefined } = {},
    signal?: AbortSignal,
  ): Promise<JobObservation> {
    this.assertCurrent(scope);
    const observation = await client.observe(
      { name: job.name, nativeId: job.nativeId, ...options },
      signal,
    );
    this.assertCurrent(scope);
    assertIdentity(job, observation.daemon);
    const view = await this.logs(
      scope,
      client,
      job,
      observation.daemon,
      { screenLogs: observation.logs },
      signal,
    );
    return { ...observation, ...view };
  }

  #decode(
    scope: Scope,
    job: JobRecord,
    daemon: DaemonSnapshot,
    logs: Logs,
  ): { logs: Logs; pending: string | undefined; redrawing: boolean } {
    return decodeOutput(
      this.delivery(scope, job),
      this.#outputReads.get(logs),
      daemon,
      logs,
    );
  }

  consume(
    scope: Scope,
    job: JobRecord,
    daemon: DaemonSnapshot,
    logs: Logs,
    options: {
      markDelivered?: boolean | undefined;
      completionId?: string | undefined;
      deliveredAt?: number | undefined;
    } = {},
  ): DeliveryRecord {
    this.assertCurrent(scope);
    const previous = this.delivery(scope, job);
    const decoded = this.#decode(scope, job, daemon, logs);
    const advancing = logs.cursor >= (previous.outputCursor ?? 0);
    const read = this.#outputReads.get(logs);
    const complete =
      terminal(daemon) &&
      (logs.state === "exited" || logs.state === "failed") &&
      (!read || read.cursor >= read.availableEnd);
    const delivery: DeliveryRecord = {
      ...previous,
      outputCursor: Math.max(previous.outputCursor ?? 0, logs.cursor),
      ...(advancing ? { decoderPending: decoded.pending } : {}),
      terminalRedraw: decoded.redrawing,
      ...(complete && options.markDelivered ? { delivered: true } : {}),
      ...(daemon.exitCode !== undefined ? { remoteExitCode: daemon.exitCode } : {}),
      ...(daemon.exitedAt !== undefined ? { finishedAt: daemon.exitedAt } : {}),
      ...(options.completionId !== undefined
        ? { completionId: options.completionId }
        : {}),
      ...(options.deliveredAt !== undefined
        ? { deliveredAt: options.deliveredAt }
        : {}),
    };
    const key = nativeKey(job.installationId, job.scopeId, job.nativeId);
    if (options.deliveredAt !== undefined) scope.deliveries.set(key, delivery);
    this.#api.appendEntry(ENTRY_TYPE, delivery);
    scope.deliveries.set(key, delivery);
    return delivery;
  }

  result(
    scope: Scope,
    job: JobRecord,
    daemon: DaemonSnapshot,
    logs: Logs,
    options: JobResultOptions = {},
  ): Result {
    this.assertCurrent(scope);
    const decoded = this.#decode(scope, job, daemon, logs);
    const previous = this.delivery(scope, job);
    const cursor = Math.max(previous.outputCursor ?? 0, logs.cursor);
    // A message alone can restore safely even if appending its delivery entry fails
    const pending =
      logs.cursor >= (previous.outputCursor ?? 0)
        ? decoded.pending
        : previous.decoderPending;
    const unreadCursor = cursor - (pending ? Buffer.from(pending, "base64").length : 0);
    const result = jobResult(daemon.exitCode, job, daemon, decoded.logs, {
      ...options,
      unreadCursor,
      terminalRedraw: decoded.redrawing,
    });
    if (options.consume !== false) this.consume(scope, job, daemon, logs, options);
    return result;
  }

  async stop(
    scope: Scope,
    client: Gateway,
    job: JobRecord,
    daemon: DaemonSnapshot,
  ): Promise<{ daemon: DaemonSnapshot; notice: string } & TerminationResult> {
    this.assertCurrent(scope);
    const stopped = await client.terminate({
      name: job.name,
      nativeId: job.nativeId,
      actionId: randomUUID(),
      kind: "stop",
      timeoutMs: 2000,
    });
    this.assertCurrent(scope);
    if (stopped.receipt.daemon) {
      assertIdentity(job, stopped.receipt.daemon);
      daemon = stopped.receipt.daemon;
    } else ({ daemon } = await this.inspect(scope, client, job));
    return {
      ...stopped,
      daemon,
      notice: `Stop ${stopped.receipt.state} · leader ${stopped.termination.leaderExited ? "exited" : "not confirmed exited"} · children ${stopped.termination.childrenGone}`,
    };
  }

  async disconnect(connection: Connection): Promise<void> {
    const scope = this.#scope;
    if (!scope) return;
    const route = JSON.stringify([
      connection.target,
      connection.controlPath,
      scope.scopeId,
      scope.owner,
    ]);
    const pending = this.#routes.get(route);
    if (!pending) return;
    this.#routes.delete(route);
    const client = await pending;
    await client.close();
  }

  #release(): void {
    for (const pending of this.#routes.values())
      void pending.then(
        (client) => client.close(),
        () => {},
      );
    this.#routes.clear();
    this.#clients.clear();
    for (const foreground of this.#scope?.foreground.values() ?? [])
      foreground.resolve();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#release();
    this.#scope = undefined;
  }
}
