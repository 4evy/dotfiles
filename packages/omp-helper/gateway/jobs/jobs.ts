import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { link, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import {
  type DaemonOperation,
  parseDaemonRpcResult,
  parseDaemonSnapshot,
  parseDaemonSpec,
  parseDaemonWireRequest,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { z } from "zod";
import { BoundedFrames } from "../../../../dotfiles/dot_omp/agent/lib/helper/bounds";
import {
  actionRequestSchema,
  JOB_CAPABILITIES,
  JOB_COMPLETION_METHOD,
  jobEnvironmentKey,
  jobEnvironmentSchema,
  jobIdentitySchema,
  observeRequestSchema,
  prepareStartRequestSchema,
  receiptRequestSchema,
  terminationRequestSchema,
} from "../../../../dotfiles/dot_omp/agent/lib/helper/jobs";
import {
  exists,
  loadIdentity,
  MAX_REQUEST_BYTES,
  PROTOCOL_MAJOR,
  paths,
  privateDirectory,
  privateRead,
  VERSION,
  withMaintenanceLock,
} from "../state";
import { JobActions } from "./actions";
import { bindDeadline, deadlineEvidence, prepareDeadline } from "./deadline";

const scopeSchema = z.strictObject({
  scopeId: z.string().regex(/^[a-f0-9]{64}$/u),
  owner: z.string().regex(/^remote:[^\0]+:[^\0]+$/u),
  installationId: z.uuid(),
});
const environmentKey =
  /^(?:HOME|PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|TZ|TMPDIR|XDG_(?:CONFIG_HOME|DATA_HOME|STATE_HOME|CACHE_HOME|RUNTIME_DIR|CONFIG_DIRS|DATA_DIRS))$/u;

const MUTATING_OPERATIONS = new Set<DaemonOperation["op"]>(["send", "stop", "mode"]);
const FORBIDDEN_OPERATIONS = new Set<DaemonOperation["op"]>(["restart", "shutdown"]);

function result(value: Record<string, unknown>) {
  return {
    content: [],
    structuredContent: value,
  };
}

function assertManagedLaunch(
  request: DaemonOperation,
  owner: string,
  env: Record<string, string>,
): asserts request is Extract<DaemonOperation, { op: "start" }> {
  if (
    request.op !== "start" ||
    request.owner !== owner ||
    request.replace !== false ||
    request.spec.restart !== "no" ||
    request.spec.detached ||
    !request.spec.cwd.startsWith("/") ||
    !request.spec.application.startsWith("/")
  )
    throw new Error("Invalid managed remote launch specification");
  validateEnvironment(request.spec.env, env);
}

function executionEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        environmentKey.test(entry[0]) && entry[1] !== undefined,
    ),
  );
}

function validateEnvironment(
  env: Record<string, string>,
  baseline: Record<string, string>,
): void {
  const changes: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (baseline[key] !== value) changes[key] = value;
  }
  if (
    Object.entries(baseline).some(
      ([key, value]) => !jobEnvironmentKey.test(key) && env[key] !== value,
    )
  )
    throw new Error("Job identity environment must match the gateway");
  if (!jobEnvironmentSchema.safeParse(changes).success)
    throw new Error(
      "Job environment overrides must use allowed names and bounded NUL-free values",
    );
}

async function brokerDirectory(directory: string): Promise<string> {
  // AF_UNIX paths on Darwin are limited to 104 bytes, including the socket name
  const root = `/tmp/omp-jobs-${process.getuid?.()}`;
  await privateDirectory(root);
  const runtime = join(root, createHash("sha256").update(directory).digest("hex"));
  await privateDirectory(runtime);
  return runtime;
}

function operation(value: unknown): DaemonOperation {
  return parseDaemonWireRequest({ id: "gateway", token: "gateway", operation: value })
    .operation;
}

function requirePatchedRuntime(): void {
  const size = { columns: 121, rows: 41 };
  const spec = parseDaemonSpec({
    name: "capability",
    application: "bash",
    args: [],
    env: {},
    cwd: "/",
    pty: true,
    terminalSize: size,
    restart: "no",
    persist: false,
    detached: false,
  });
  const resize = operation({ op: "send", name: "capability", resize: size });
  const snapshot = parseDaemonSnapshot({
    name: "capability",
    id: "capability",
    state: "running",
    createdAt: 1,
    startedAt: 1,
    restartCount: 0,
    outputBytes: 0,
    persist: false,
    detached: false,
    terminalSize: size,
  });
  const replay = parseDaemonRpcResult(
    {
      op: "logs",
      name: "capability",
      lines: 1,
      head: false,
      follow: false,
      timeoutMs: 0,
      renderTerminalRows: true,
    },
    {
      name: "capability",
      text: "",
      terminalRows: [""],
      cursor: 0,
      timedOut: false,
      state: "running",
      terminalSize: size,
    },
  );
  const outputRequest = operation({
    op: "output",
    name: "capability",
    cursor: 0,
    follow: false,
    timeoutMs: 0,
  });
  const output = parseDaemonRpcResult(outputRequest, {
    name: "capability",
    data: "Hg==",
    startCursor: 0,
    cursor: 1,
    availableStart: 0,
    availableEnd: 1,
    timedOut: false,
    state: "running",
  });
  if (
    spec.terminalSize?.columns !== size.columns ||
    resize.op !== "send" ||
    resize.resize?.rows !== size.rows ||
    snapshot.terminalSize?.rows !== size.rows ||
    replay.op !== "logs" ||
    replay.terminalRows?.length !== 1 ||
    replay.terminalSize?.columns !== size.columns ||
    output.op !== "output" ||
    output.data !== "Hg==" ||
    output.cursor !== 1
  )
    throw new Error(
      "The packaged broker lacks required terminal or incremental output support",
    );
}

export async function verifyBrokerRuntime(): Promise<void> {
  requirePatchedRuntime();
  const directory = join(paths().state, "health");
  await privateDirectory(directory);
  const canonical = await realpath(directory);
  const broker = await createDaemonBrokerClient(canonical, {
    runtimeDir: await brokerDirectory(canonical),
  });
  try {
    const response = await broker.request({ op: "ping" });
    if (response.op !== "ping" || response.projectDir !== canonical)
      throw new Error("Packaged broker health identity mismatch");
  } finally {
    broker.close();
  }
}

async function scopeDirectory(scopeId: string, owner: string): Promise<string> {
  const { installationId } = await loadIdentity();
  const metadata = scopeSchema.parse({ scopeId, owner, installationId });
  const root = join(await realpath(paths().state), "scopes");
  await privateDirectory(root);
  const directory = join(root, scopeId);
  await privateDirectory(directory);
  if ((await realpath(directory)) !== directory)
    throw new Error("Broker scope must be a canonical private directory");
  const file = join(directory, "scope.json");
  const temporary = join(directory, `.scope-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
    await link(temporary, file);
  } catch (error) {
    if (!isEexist(error)) throw error;
    const existing = scopeSchema.parse(JSON.parse(await privateRead(file)));
    if (
      existing.owner !== owner ||
      existing.scopeId !== scopeId ||
      existing.installationId !== installationId
    )
      throw new Error("Broker scope identity mismatch");
  } finally {
    await rm(temporary, { force: true });
  }
  return directory;
}

export async function inspectBusyJobs(): Promise<boolean> {
  const root = join(paths().state, "scopes");
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
  await privateDirectory(root);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name))
      throw new Error("Unexpected entry in private broker scopes");
    const directory = join(root, entry.name);
    await privateDirectory(directory);
    const metadata = scopeSchema.parse(
      JSON.parse(await privateRead(join(directory, "scope.json"))),
    );
    if (metadata.scopeId !== entry.name)
      throw new Error("Broker scope directory identity mismatch");
    const broker = await createDaemonBrokerClient(directory, {
      runtimeDir: await brokerDirectory(directory),
    });
    try {
      const result = await broker.request({ op: "list" });
      if (result.op !== "list") throw new Error("Unexpected broker list response");
      if (
        result.daemons.some(
          (daemon) => daemon.state !== "exited" && daemon.state !== "failed",
        )
      )
        return true;
    } finally {
      broker.close();
    }
  }
  return false;
}

export async function runJobs(scopeId: string, owner: string): Promise<void> {
  requirePatchedRuntime();
  const directory = await scopeDirectory(scopeId, owner);
  const identity = await loadIdentity();
  const broker = await createDaemonBrokerClient(directory, {
    runtimeDir: await brokerDirectory(directory),
  });
  const actions = new JobActions(
    broker,
    directory,
    scopeId,
    owner,
    identity.installationId,
  );
  const server = new McpServer({ name: "omp-helper-jobs", version: VERSION });
  const acknowledgments = new Map<string, PromiseWithResolvers<void>>();
  let closed = false;
  let subscribed = false;
  let unsubscribe: ((options?: { preservePending?: boolean }) => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.({ preservePending: true });
    for (const pending of acknowledgments.values())
      pending.reject(new Error("Completion channel closed before acknowledgment"));
    acknowledgments.clear();
    broker.close();
  };
  server.server.onclose = close;
  const env = executionEnvironment();
  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    unsubscribe = broker.onCompletion(owner, async (notification) => {
      if (closed) throw new Error("Completion channel is closed");
      const pending = Promise.withResolvers<void>();
      void pending.promise.catch(() => {});
      acknowledgments.set(notification.completionId, pending);
      try {
        await server.server.notification({
          method: JOB_COMPLETION_METHOD,
          params: { notification },
        });
        await pending.promise;
      } finally {
        acknowledgments.delete(notification.completionId);
      }
    });
  };
  server.registerTool("helper.handshake", { inputSchema: {} }, async () => {
    subscribe();
    return result({
      protocolMajor: PROTOCOL_MAJOR,
      version: VERSION,
      installationId: identity.installationId,
      platform: process.platform,
      capabilities: [...JOB_CAPABILITIES],
    });
  });
  server.registerTool("job.environment", { inputSchema: {} }, async () =>
    result({ env }),
  );
  server.registerTool(
    "job.ack_completion",
    { inputSchema: { completionId: z.string().min(1) } },
    async ({ completionId }) => {
      const pending = acknowledgments.get(completionId);
      if (!pending) throw new Error("Unknown or expired completion acknowledgment");
      pending.resolve();
      return result({ accepted: true });
    },
  );
  const requireHandshake = () => {
    if (!subscribed)
      throw new Error("helper.handshake is required before job operations");
  };
  server.registerTool(
    "job.observe",
    { inputSchema: observeRequestSchema.shape },
    async (input) => {
      requireHandshake();
      return result(await actions.observe(input));
    },
  );
  server.registerTool(
    "job.action",
    {
      inputSchema: actionRequestSchema.shape,
      description:
        "Send each action ID at most once. Processed means broker accepted and a terminal screen was observed, not application acknowledgement",
    },
    async (input) => {
      requireHandshake();
      return result(await actions.action(input));
    },
  );
  server.registerTool(
    "job.receipt",
    { inputSchema: receiptRequestSchema.shape },
    async (input) => {
      requireHandshake();
      return result(await actions.receipt(input));
    },
  );
  server.registerTool(
    "job.terminate",
    { inputSchema: terminationRequestSchema.shape },
    async (input) => {
      requireHandshake();
      return result(await actions.terminate(input));
    },
  );
  server.registerTool(
    "job.termination",
    { inputSchema: jobIdentitySchema.shape },
    async ({ name, nativeId }) => {
      requireHandshake();
      const described = await broker.request({ op: "describe", name });
      if (
        described.op !== "describe" ||
        described.daemon.owner !== owner ||
        described.daemon.id !== nativeId
      )
        throw new Error("Job identity or remote owner mismatch");
      await bindDeadline(
        directory,
        described.spec,
        nativeId,
        identity.installationId,
        scopeId,
        owner,
      );
      return result({
        termination: await actions.termination(name, nativeId),
        deadline: await deadlineEvidence(
          directory,
          name,
          nativeId,
          identity.installationId,
          scopeId,
          owner,
        ),
      });
    },
  );
  server.registerTool(
    "job.prepare_start",
    { inputSchema: prepareStartRequestSchema.shape },
    async (input) => {
      requireHandshake();
      const { operation: value, deadlineSeconds } =
        prepareStartRequestSchema.parse(input);
      const request = operation(value);
      assertManagedLaunch(request, owner, env);
      return withMaintenanceLock(async () =>
        result({
          spec: await prepareDeadline(
            directory,
            scopeId,
            owner,
            identity.installationId,
            request.spec,
            deadlineSeconds,
          ),
        }),
      );
    },
  );
  server.registerTool(
    "job.request",
    { inputSchema: { operation: z.unknown() } },
    async (input) => {
      requireHandshake();
      const request = operation(input.operation);
      if (
        FORBIDDEN_OPERATIONS.has(request.op) ||
        (request.op === "mode" && request.mode === "detached")
      )
        throw new Error(
          "Restart, shutdown, and detached conversion are not exposed by the helper",
        );
      if (request.op === "start") {
        assertManagedLaunch(request, owner, env);
        const spec = request.spec;
        return withMaintenanceLock(async () => {
          if (!(await exists(join(paths().state, "installer.json"))))
            throw new Error("Helper is not activated; managed launches are disabled");
          const response = await broker.request(request);
          if (response.op !== "start")
            throw new Error("Unexpected broker launch response");
          await bindDeadline(
            directory,
            spec,
            response.daemon.id,
            identity.installationId,
            scopeId,
            owner,
          );
          return result(response);
        });
      }
      if ("name" in request) {
        const described = await broker.request({ op: "describe", name: request.name });
        if (described.op !== "describe" || described.daemon.owner !== owner)
          throw new Error("Job belongs to another remote owner");
      }
      const response =
        "name" in request && MUTATING_OPERATIONS.has(request.op)
          ? await actions.mutate(
              request.name,
              (await actions.bind(request.name)).id,
              () => broker.request(request),
            )
          : await broker.request(request);
      if (response.op === "list")
        response.daemons = response.daemons.filter((daemon) => daemon.owner === owner);
      return result(response);
    },
  );
  const bounded = new BoundedFrames(MAX_REQUEST_BYTES, "MCP request exceeds 1 MiB");
  bounded.on("error", () => {
    close();
    void server.close();
  });
  process.stdin.on("end", () => {
    close();
    void server.close();
  });
  process.stdin.on("error", () => {
    close();
    void server.close();
  });
  process.stdin.pipe(bounded);
  try {
    await server.connect(new StdioServerTransport(bounded, process.stdout));
    await new Promise<void>((resolve) => {
      if (closed) resolve();
      else
        server.server.onclose = () => {
          close();
          resolve();
        };
    });
  } finally {
    close();
  }
}
