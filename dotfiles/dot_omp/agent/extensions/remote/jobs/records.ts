import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { parseDaemonSpec } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { isRecord } from "@oh-my-pi/pi-utils";
import { z } from "zod";
import type { DeliveryRecord, LaunchRecord, Scope } from "./types";
import { MAX_WAIT_SECONDS, NAME_PATTERN } from "./validation";

export const ENTRY_TYPE = "remote-jobs";
export const COMPLETION_TYPE = "remote-job-completion";
export function owner(ctx: ExtensionContext): string {
  return `remote:${ctx.sessionManager.getSessionId()}:${ctx.agent.id}`;
}
export function nativeKey(
  installationId: string,
  scopeId: string,
  nativeId: string,
): string {
  return `${installationId}:${scopeId}:${nativeId}`;
}
const identityFields = {
  version: z.literal(2),
  name: z.string().regex(NAME_PATTERN),
  owner: z.string().min(1),
  installationId: z.uuid(),
  scopeId: z.string().regex(/^[a-f0-9]{64}$/u),
};
export const launchSchema = z.strictObject({
  ...identityFields,
  kind: z.enum(["launch", "job"]),
  projectDir: z.string().startsWith("/"),
  connectionId: z.string().min(1),
  command: z.string().min(1),
  interpreter: z.string().min(1).optional(),
  cwd: z.string().startsWith("/"),
  pty: z.boolean(),
  timeoutSeconds: z.number().min(0).max(MAX_WAIT_SECONDS),
  createdAt: z.number().nonnegative(),
  ready: z.string().optional(),
  nativeId: z.string().min(1).optional(),
  startedAt: z.number().nonnegative().optional(),
  nativeCreatedAt: z.number().nonnegative().optional(),
  spec: z.unknown().transform((value, ctx) => {
    try {
      return parseDaemonSpec(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid native launch spec" });
      return z.NEVER;
    }
  }),
});
export const jobSchema = launchSchema.extend({
  kind: z.literal("job"),
  nativeId: launchSchema.shape.nativeId.unwrap(),
  startedAt: launchSchema.shape.startedAt.unwrap(),
  nativeCreatedAt: launchSchema.shape.nativeCreatedAt.unwrap(),
});
export const deliverySchema = z.strictObject({
  ...identityFields,
  kind: z.literal("delivery"),
  nativeId: z.string().min(1),
  delivered: z.boolean(),
  remoteExitCode: z.number().int().optional(),
  completionId: z.string().min(1).optional(),
  outputCursor: z.number().int().nonnegative().optional(),
  decoderPending: z
    .string()
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
    .max(4)
    .optional(),
  terminalRedraw: z.boolean().optional(),
  finishedAt: z.number().nonnegative().optional(),
  deliveredAt: z.number().nonnegative().optional(),
});

function parseEntry(
  value: unknown,
  scope: Scope,
): LaunchRecord | DeliveryRecord | undefined {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.owner !== scope.owner ||
    value.scopeId !== scope.scopeId
  )
    return;
  if (value.kind === "delivery") {
    const parsed = deliverySchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }
  const parsed = (value.kind === "job" ? jobSchema : launchSchema).safeParse(value);
  if (!parsed.success) return;
  const record = parsed.data;
  if (
    record.projectDir !== scope.projectDir ||
    record.name !== record.spec.name ||
    record.cwd !== record.spec.cwd ||
    record.pty !== record.spec.pty
  )
    return;
  return record;
}

export function recordInto(
  records: Map<string, LaunchRecord>,
  record: LaunchRecord,
): void {
  const previous = records.get(record.name);
  if (!previous) {
    records.set(record.name, record);
    return;
  }
  const {
    kind: _leftKind,
    nativeId: _leftId,
    startedAt: _leftStart,
    nativeCreatedAt: _leftCreated,
    ...left
  } = previous;
  const {
    kind: _rightKind,
    nativeId: _rightId,
    startedAt: _rightStart,
    nativeCreatedAt: _rightCreated,
    ...right
  } = record;
  if (!isDeepStrictEqual(left, right))
    throw new Error(`Conflicting immutable launch metadata for ${record.name}`);
  if (
    previous.kind === "job" &&
    (previous.nativeId !== record.nativeId ||
      previous.startedAt !== record.startedAt ||
      previous.nativeCreatedAt !== record.nativeCreatedAt)
  )
    throw new Error(`Conflicting native identity for ${record.name}`);
  records.set(record.name, record);
}

export function restoreScope(ctx: ExtensionContext): Scope {
  const projectDir = realpathSync(ctx.cwd);
  const owned = owner(ctx);
  const scope: Scope = {
    ctx,
    owner: owned,
    projectDir,
    scopeId: createHash("sha256")
      .update(owned)
      .update("\0")
      .update(projectDir)
      .digest("hex"),
    branch: new Map(),
    all: new Map(),
    deliveries: new Map(),
    foreground: new Map(),
  };
  for (const entry of ctx.sessionManager.getEntries()) {
    let data: unknown;
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE) data = entry.data;
    else if (
      entry.type === "custom_message" &&
      entry.customType === COMPLETION_TYPE &&
      isRecord(entry.details)
    ) {
      data = {
        version: 2,
        kind: "delivery",
        delivered: true,
        name: entry.details.job,
        owner: entry.details.owner,
        nativeId: entry.details.nativeId,
        installationId: entry.details.installationId,
        scopeId: entry.details.scopeId,
        remoteExitCode: entry.details.remoteExitCode,
        completionId: entry.details.completionId,
        outputCursor: entry.details.unreadCursor ?? entry.details.cursor,
        finishedAt: entry.details.finishedAt,
        deliveredAt: entry.details.deliveredAt,
      };
    } else continue;
    const parsed = parseEntry(data, scope);
    if (!parsed) continue;
    if (parsed.kind === "delivery") {
      const key = nativeKey(parsed.installationId, parsed.scopeId, parsed.nativeId);
      const previous = scope.deliveries.get(key);
      if (
        previous &&
        (previous.name !== parsed.name || previous.owner !== parsed.owner)
      )
        continue;
      const advancing =
        parsed.outputCursor !== undefined &&
        parsed.outputCursor >= (previous?.outputCursor ?? 0);
      scope.deliveries.set(key, {
        ...previous,
        ...parsed,
        delivered: Boolean(previous?.delivered || parsed.delivered),
        outputCursor: Math.max(previous?.outputCursor ?? 0, parsed.outputCursor ?? 0),
        decoderPending: advancing ? parsed.decoderPending : previous?.decoderPending,
        terminalRedraw: Boolean(previous?.terminalRedraw || parsed.terminalRedraw),
      });
    } else recordInto(scope.all, parsed);
  }
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const parsed = parseEntry(entry.data, scope);
    if (parsed && parsed.kind !== "delivery") recordInto(scope.branch, parsed);
  }
  return scope;
}
