import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { parseDaemonSpec } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { toolResult } from "@oh-my-pi/pi-coding-agent/tools/tool-result";
import type { BashToolDetails } from "@oh-my-pi/pi-tui/tools/bash";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { OutputSink } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { resolveRemoteCwd } from "../connections/target";
import type { Connection } from "../connections/types";
import { terminal } from "../jobs/broker";
import type { Gateway } from "../jobs/gateway";
import type { JobSession } from "../jobs/session";
import type { Scope } from "../jobs/types";
import { SudoFrames } from "./frames";
import { sudoState, sudoStatus } from "./result";
import { AUTH_SECONDS, type SudoInput, sudoShell } from "./script";

const PROMPT_SECONDS = 120;
const DEFAULT_COMMAND_SECONDS = 60;
const MAX_COMMAND_SECONDS = 3600;
const DEADLINE_GRACE_SECONDS = 5;
const OUTPUT_POLL_MS = 1000;

class SudoExecution {
  readonly state = sudoState();
  #bound: DaemonSnapshot | undefined;
  #credentialTask: Promise<void> | undefined;
  #deadline: NodeJS.Timeout | undefined;
  #stopping: Promise<void> | undefined;
  readonly #cancellation = new AbortController();
  readonly #installationId: string;
  readonly #frames: SudoFrames;

  constructor(
    private readonly session: JobSession,
    private readonly scope: Scope,
    private readonly connection: Connection,
    private client: Gateway,
    private readonly spec: ReturnType<typeof parseDaemonSpec>,
    private readonly input: SudoInput,
    private readonly ctx: ExtensionContext,
    private readonly seconds: number,
    marker: string,
    sink: OutputSink,
  ) {
    this.#installationId = client.installationId;
    this.#frames = new SudoFrames(marker, (text) => sink.push(text), this.#control);
  }

  async #inspect() {
    this.session.assertCurrent(this.scope);
    const described = await this.client.request({
      op: "describe",
      name: this.spec.name,
    });
    if (
      described.daemon.owner !== this.scope.owner ||
      !isDeepStrictEqual(described.spec, this.spec) ||
      described.daemon.restartCount !== 0 ||
      (this.#bound &&
        (described.daemon.id !== this.#bound.id ||
          described.daemon.startedAt !== this.#bound.startedAt ||
          described.daemon.createdAt !== this.#bound.createdAt))
    )
      throw new Error("Internal sudo native identity changed");
    this.#bound ??= described.daemon;
    return described.daemon;
  }

  #stop() {
    this.#stopping ??= (async () => {
      this.client = await this.session.client(
        this.scope,
        this.connection,
        this.#installationId,
      );
      const daemon = await this.#inspect();
      if (terminal(daemon)) this.state.stopConfirmed = true;
      else {
        const stopped = await this.client.request({
          op: "stop",
          name: this.spec.name,
          timeoutMs: OUTPUT_POLL_MS,
        });
        this.state.stopConfirmed = terminal(stopped.daemon);
      }
    })().catch(() => {});
    return this.#stopping;
  }

  readonly #cancel = () => {
    this.#cancellation.abort();
    if (this.#bound) void this.#stop();
  };

  #armDeadline(milliseconds: number) {
    clearTimeout(this.#deadline);
    this.#deadline = setTimeout(() => {
      this.state.localDeadline = true;
      this.#cancel();
    }, milliseconds);
    this.#deadline.unref?.();
  }

  async #credentials() {
    this.#armDeadline((PROMPT_SECONDS + AUTH_SECONDS + DEADLINE_GRACE_SECONDS) * 1000);
    let password = this.input.password;
    if (password === undefined && this.ctx.hasUI) {
      password = await this.ctx.ui.input(
        `Sudo password (${this.connection.id}; Esc cancels): `,
        undefined,
        {
          signal: AbortSignal.any([
            this.#cancellation.signal,
            AbortSignal.timeout(PROMPT_SECONDS * 1000),
          ]),
        },
      );
      if (password === undefined) this.state.promptCancelled = true;
    }
    if (this.#cancellation.signal.aborted) return;
    if (password === undefined) {
      this.state.authRequired = !this.state.promptCancelled;
      await this.#stop();
      return;
    }
    if (/[\r\n\0]/u.test(password)) {
      this.state.invalidPrompt = true;
      await this.#stop();
      return;
    }
    this.#armDeadline((AUTH_SECONDS + DEADLINE_GRACE_SECONDS) * 1000);
    await this.#inspect();
    // Credential bytes are sent only to pipe stdin and never copied into metadata
    await this.client.request({
      op: "send",
      name: this.spec.name,
      data: `${password}\n`,
    });
  }

  readonly #controls: Readonly<Record<string, () => void>> = {
    credentials: () => {
      this.#credentialTask ??= this.#credentials().catch(async () => {
        this.state.promptCancelled = true;
        await this.#stop();
      });
    },
    started: () => {
      this.state.commandStarted = true;
      this.#armDeadline((this.seconds + DEADLINE_GRACE_SECONDS) * 1000);
    },
    timeout: () => {
      this.state.timedOut = true;
    },
    required: () => {
      this.state.authRequired = true;
    },
    rejected: () => {
      this.state.authRejected = true;
    },
  };

  readonly #control = (record: string) => {
    if (Object.hasOwn(this.#controls, record)) this.#controls[record]?.();
    else if (/^done:\d+$/u.test(record)) {
      const value = Number(record.slice(5));
      if (value <= 255) this.state.exitCode = value;
    }
  };

  async run(signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      signal?.addEventListener("abort", this.#cancel, { once: true });
      this.#armDeadline((AUTH_SECONDS * 2 + 10) * 1000);
      try {
        await this.client.request(
          { op: "start", spec: this.spec, owner: this.scope.owner, replace: false },
          signal,
        );
      } catch {
        // A lost start reply is inspected, never replayed
        this.client = await this.session.client(
          this.scope,
          this.connection,
          this.#installationId,
        );
      }
      let daemon = await this.#inspect();
      if (signal?.aborted) await this.#stop();
      let cursor = 0;
      for (;;) {
        const finishedBeforeRead = terminal(daemon);
        const output = await this.client.request({
          op: "output",
          name: this.spec.name,
          follow: !finishedBeforeRead,
          timeoutMs: OUTPUT_POLL_MS,
          cursor,
        });
        if (output.startCursor !== cursor) {
          this.state.outputLost = true;
          throw new Error("Sudo output is no longer retained");
        }
        cursor = output.cursor;
        this.#frames.consume(Buffer.from(output.data, "base64"));
        daemon = await this.#inspect();
        if (finishedBeforeRead && cursor >= output.availableEnd) break;
        if (this.#cancellation.signal.aborted) {
          await this.#stop();
          break;
        }
      }
    } catch {
      // Channel loss does not establish cancellation or command completion
      this.#cancellation.abort();
    } finally {
      clearTimeout(this.#deadline);
      signal?.removeEventListener("abort", this.#cancel);
      this.#cancellation.abort();
      await this.#credentialTask;
      await this.#stopping;
      this.#frames.consume(Buffer.alloc(0), true);
    }
  }
}

/** Authenticate privately, then run exactly one bounded command with closed stdin */
export async function runSudo(
  session: JobSession,
  connection: Connection,
  input: SudoInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
): Promise<AgentToolResult<BashToolDetails>> {
  const startedAt = Date.now();
  const seconds = input.timeout ?? DEFAULT_COMMAND_SECONDS;
  const details: BashToolDetails = { timeoutSeconds: seconds };
  const failure = (text: string) => toolResult(details).text(text).error().done();
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_COMMAND_SECONDS)
    return failure(
      `Sudo timeout must be greater than zero and at most ${MAX_COMMAND_SECONDS} seconds`,
    );
  if (!input.command?.trim() || input.command.includes("\0"))
    return failure("Sudo requires a nonempty Bash command without NUL characters");
  if (input.password !== undefined && /[\r\n\0]/u.test(input.password))
    return failure("Sudo passwords must be single-line values without NUL characters");
  if (signal?.aborted)
    return failure("Sudo request cancelled before execution; no command was run");
  const scope = session.current(ctx);
  const client = await session.client(scope, connection);
  const marker = `\x1eOMP_SUDO_${randomUUID().replaceAll("-", "")}:`;
  const name = `remote-sudo-internal-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const spec = parseDaemonSpec({
    name,
    application: connection.bash,
    args: [
      "--noprofile",
      "--norc",
      "-c",
      sudoShell(connection, input, seconds, marker),
    ],
    env: client.env,
    cwd: resolveRemoteCwd(connection, input.cwd),
    pty: false,
    restart: "no",
    persist: false,
    detached: false,
  });
  const artifact = await ctx.sessionManager.allocateArtifactPath("remote_sudo");
  const sink = new OutputSink({
    ...(artifact.path === undefined ? {} : { artifactPath: artifact.path }),
    ...(artifact.id === undefined ? {} : { artifactId: artifact.id }),
    onChunk: (chunk) =>
      onUpdate?.({ content: [{ type: "text", text: chunk }], details: {} }),
    chunkThrottleMs: 100,
  });
  const execution = new SudoExecution(
    session,
    scope,
    connection,
    client,
    spec,
    input,
    ctx,
    seconds,
    marker,
    sink,
  );
  await execution.run(signal);
  details.wallTimeMs = Date.now() - startedAt;
  const { status, failed } = sudoStatus(
    execution.state,
    details,
    seconds,
    signal?.aborted ?? false,
  );
  const summary = await sink.dump();
  return toolResult(details)
    .text(`${summary.output || "(no output)"}\n\n${status}`)
    .truncationFromSummary(summary, { direction: "tail" })
    .error(failed)
    .done();
}
