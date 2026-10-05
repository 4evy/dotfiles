import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Connections } from "../connections/state";
import type { Connection } from "../connections/types";
import { runSudo } from "../sudo";
import type { SudoInput } from "../sudo/script";
import { controlJob } from "./control";
import { runJob } from "./launch/launch";
import { JobSession } from "./session";
import type { JobInput, RemoteJobDetails, Result, RunInput } from "./types";

export class RemoteJobs {
  readonly #session: JobSession;
  constructor(api: ExtensionAPI, connections: Connections) {
    this.#session = new JobSession(api, connections);
  }
  restore(ctx: ExtensionContext): void {
    this.#session.restore(ctx);
  }
  run(
    connection: Connection,
    input: RunInput,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<RemoteJobDetails>,
  ): Promise<Result> {
    return runJob(this.#session, connection, input, ctx, signal, onUpdate);
  }
  control(
    input: JobInput,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<Result> {
    return controlJob(this.#session, input, ctx, signal);
  }
  sudo(
    connection: Connection,
    input: SudoInput,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ) {
    return runSudo(this.#session, connection, input, ctx, signal, onUpdate);
  }
  disconnect(connection: Connection): Promise<void> {
    return this.#session.disconnect(connection);
  }
  close(): void {
    this.#session.close();
  }
}
