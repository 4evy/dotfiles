import { randomUUID } from "node:crypto";
import {
  type DaemonCompletionNotification,
  type DaemonOperation,
  type DaemonRpcResult,
  parseDaemonRpcResult,
  parseDaemonWireMessage,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { quotePosixPath } from "@oh-my-pi/pi-coding-agent/ssh/utils";
import { z } from "zod";
import { connectHelper, type HelperConnection } from "../../../lib/helper/bun";
import {
  type ActionReceipt,
  type ActionRequest,
  actionReceiptSchema,
  JOB_CAPABILITIES,
  JOB_COMPLETION_METHOD,
  type JobObservation,
  observeResultSchema,
  type PrepareStartRequest,
  prepareStartResultSchema,
  type TerminationRequest,
  type TerminationResult,
  type TerminationStatus,
  terminationResultSchema,
  terminationStatusSchema,
} from "../../../lib/helper/jobs";
import { remoteArgv } from "../connections/command";
import type { Connection } from "../connections/types";

const environmentSchema = z.strictObject({ env: z.record(z.string(), z.string()) });
const notificationSchema = z.strictObject({ notification: z.unknown() });
const acknowledgmentSchema = z.strictObject({ accepted: z.literal(true) });

export class Gateway {
  readonly scopeId: string;
  readonly owner: string;
  readonly installationId: string;
  readonly env: Record<string, string>;
  readonly #helper: HelperConnection;
  #closed = false;

  private constructor(
    helper: HelperConnection,
    scopeId: string,
    owner: string,
    env: Record<string, string>,
  ) {
    this.#helper = helper;
    this.scopeId = scopeId;
    this.owner = owner;
    this.installationId = helper.identity.installationId;
    this.env = env;
  }

  static async connect(
    connection: Connection,
    scopeId: string,
    owner: string,
    onCompletion: (
      client: Gateway,
      notification: DaemonCompletionNotification,
    ) => Promise<void>,
    onClose: (client: Gateway | undefined) => void,
  ): Promise<Gateway> {
    if (connection.info.os !== "linux" && connection.info.os !== "macos")
      throw new Error("Managed jobs require a Linux or macOS omp-helper target");
    const args = await remoteArgv(
      connection,
      `helper="\${XDG_DATA_HOME:-$HOME/.local/share}/omp-helper/current/bin/omp-helper"\n[ -x "$helper" ] || { printf '%s\\n' 'omp-helper is not installed; use remote_helper' >&2; exit 69; }\nexec "$helper" jobs --scope ${quotePosixPath(scopeId)} --owner ${quotePosixPath(owner)}`,
      false,
    );
    let gateway: Gateway | undefined;
    let transportClosed = false;
    const queued: DaemonCompletionNotification[] = [];
    const deliver = (notification: DaemonCompletionNotification) => {
      if (!gateway) {
        queued.push(notification);
        return;
      }
      const current = gateway;
      void onCompletion(current, notification)
        .then(async () => {
          if (current.#closed) return;
          acknowledgmentSchema.parse(
            (
              await current.#helper.call("job.ack_completion", {
                completionId: notification.completionId,
              })
            ).structuredContent,
          );
        })
        .catch(() => {
          void current.close();
        });
    };
    const helper = await connectHelper(
      `remote-jobs-${randomUUID()}`,
      { command: "ssh", args },
      {
        onNotification(method, params) {
          if (method !== JOB_COMPLETION_METHOD) return;
          const message = parseDaemonWireMessage(
            notificationSchema.parse(params).notification,
          );
          if (!("event" in message))
            throw new Error("Invalid remote completion notification");
          deliver(message);
        },
        onClose() {
          transportClosed = true;
          if (gateway) gateway.#closed = true;
          onClose(gateway);
        },
      },
    );
    try {
      for (const capability of JOB_CAPABILITIES) {
        if (!helper.identity.capabilities.includes(capability))
          throw new Error(`Remote helper lacks ${capability}`);
      }
      const { env } = environmentSchema.parse(
        (await helper.call("job.environment", {})).structuredContent,
      );
      if (transportClosed) throw new Error("Remote gateway closed during negotiation");
      gateway = new Gateway(helper, scopeId, owner, env);
      for (const notification of queued) deliver(notification);
      return gateway;
    } catch (error) {
      await helper.close();
      throw error;
    }
  }

  async request<Operation extends DaemonOperation>(
    operation: Operation,
    signal?: AbortSignal,
  ): Promise<Extract<DaemonRpcResult, { op: Operation["op"] }>> {
    const timeout =
      operation.op === "start"
        ? (operation.spec.ready?.timeoutMs ?? 30_000)
        : "timeoutMs" in operation
          ? operation.timeoutMs
          : 30_000;
    const response = await this.#call(
      "job.request",
      { operation },
      signal,
      timeout + 15_000,
    );
    // The native decoder validates the payload and derives op from this operation
    return parseDaemonRpcResult(operation, response) as Extract<
      DaemonRpcResult,
      { op: Operation["op"] }
    >;
  }

  async #call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.#closed)
      throw new Error("Remote gateway is closed; the operation was not replayed");
    const response = await this.#helper.call(tool, args, signal, timeoutMs);
    if (response.isError)
      throw new Error(
        response.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n") || "Remote job operation failed",
      );
    return response.structuredContent;
  }

  async observe(
    input: {
      name: string;
      nativeId: string;
      settleMs?: number | undefined;
      maxWaitMs?: number | undefined;
    },
    signal?: AbortSignal,
  ): Promise<JobObservation> {
    return observeResultSchema.parse(
      await this.#call("job.observe", input, signal, (input.maxWaitMs ?? 500) + 15_000),
    );
  }

  async action(input: ActionRequest, signal?: AbortSignal): Promise<ActionReceipt> {
    return actionReceiptSchema.parse(
      await this.#call("job.action", input, signal, (input.maxWaitMs ?? 500) + 15_000),
    );
  }

  async receipt(
    input: { name: string; nativeId: string; actionId: string },
    signal?: AbortSignal,
  ): Promise<ActionReceipt> {
    return actionReceiptSchema.parse(await this.#call("job.receipt", input, signal));
  }

  async terminate(
    input: TerminationRequest,
    signal?: AbortSignal,
  ): Promise<TerminationResult> {
    return terminationResultSchema.parse(
      await this.#call(
        "job.terminate",
        input,
        signal,
        (input.timeoutMs ?? 2000) + 15_000,
      ),
    );
  }

  async prepareStart(input: PrepareStartRequest, signal?: AbortSignal) {
    return prepareStartResultSchema.parse(
      await this.#call("job.prepare_start", input, signal),
    ).spec;
  }

  async termination(
    input: { name: string; nativeId: string },
    signal?: AbortSignal,
  ): Promise<TerminationStatus> {
    return terminationStatusSchema.parse(
      await this.#call("job.termination", input, signal),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#helper.close();
  }
}
