import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { DaemonCompletionNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { assertIdentity } from "./broker";
import type { Gateway } from "./gateway";
import { COMPLETION_TYPE, ENTRY_TYPE, nativeKey } from "./records";
import type { JobSession } from "./session";
import type { DeliveryRecord, JobRecord, JobView, Result, Scope } from "./types";

export async function deliverCompletion(
  session: JobSession,
  api: ExtensionAPI,
  scope: Scope,
  client: Gateway,
  notification: DaemonCompletionNotification,
): Promise<void> {
  session.assertCurrent(scope);
  if (
    notification.owner !== scope.owner ||
    notification.daemon.owner !== scope.owner ||
    client.scopeId !== scope.scopeId
  )
    throw new Error("Remote completion owner/scope mismatch");
  const completed = notification.daemon;
  // Internal sudo calls return synchronously and have no user-addressable handles
  if (completed.name.startsWith("remote-sudo-internal-")) return;
  const key = nativeKey(client.installationId, scope.scopeId, completed.id);
  for (;;) {
    const foreground = scope.foreground.get(completed.name);
    if (!foreground) break;
    await foreground.done;
    session.assertCurrent(scope);
  }
  if (scope.deliveries.get(key)?.delivered) return;
  const record = scope.all.get(completed.name);
  let job: JobRecord | undefined;
  let view: JobView | undefined;
  let unavailable = "Managed metadata is absent from this session tree";
  if (record) {
    try {
      if (record.kind === "job") assertIdentity(record as JobRecord, completed);
      const inspected = await session.inspect(scope, client, record);
      job = inspected.job;
      assertIdentity(job, completed);
      view = await session.logs(scope, client, job, inspected.daemon);
    } catch (error) {
      session.assertCurrent(scope);
      unavailable = `Managed metadata/logs could not be used: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  for (;;) {
    const foreground = scope.foreground.get(completed.name);
    if (!foreground) break;
    await foreground.done;
    session.assertCurrent(scope);
  }
  if (scope.deliveries.get(key)?.delivered) return;
  const deliveredAt = Date.now();
  const finishedAt = completed.exitedAt;
  let result: Result;
  if (job && view) {
    // Rebase unread bytes only at dispatch, after any concurrent foreground response
    result = session.result(scope, job, view.daemon, view.logs, {
      consume: false,
      finishedAt,
      deliveredAt,
    });
  } else {
    const code = completed.exitCode;
    result = {
      content: [
        {
          type: "text",
          text: `Job ${completed.name} · ${completed.state} · exit ${code ?? "unknown"}\n${unavailable}. Use remote_job with this exact handle; controls require current-branch metadata${finishedAt === undefined ? "" : `\nFinished at ${new Date(finishedAt).toISOString()} · delivered at ${new Date(deliveredAt).toISOString()} · delay ${Math.max(0, deliveredAt - finishedAt)} ms`}`,
        },
      ],
      details: {
        job: completed.name,
        nativeId: completed.id,
        owner: scope.owner,
        installationId: client.installationId,
        scopeId: scope.scopeId,
        remoteState: code === undefined ? "unknown" : "completed",
        newOutput: "",
        compact: true,
        deliveredAt,
        ...(finishedAt !== undefined
          ? { finishedAt, deliveryDelayMs: Math.max(0, deliveredAt - finishedAt) }
          : {}),
        ...(code !== undefined ? { remoteExitCode: code, exitCode: code } : {}),
        lifetime: completed.persist ? "persist" : "session",
      },
      isError: code === undefined || code !== 0,
    };
  }
  api.sendMessage(
    {
      customType: COMPLETION_TYPE,
      content: result.content,
      display: true,
      details: { ...result.details, completionId: notification.completionId },
    },
    // Aside reaches the next step boundary without interrupting an in-flight tool
    { deliverAs: "aside", triggerTurn: true },
  );
  if (job && view) {
    session.consume(scope, job, view.daemon, view.logs, {
      markDelivered: true,
      completionId: notification.completionId,
      deliveredAt,
    });
  } else {
    const delivery: DeliveryRecord = {
      ...scope.deliveries.get(key),
      version: 2,
      kind: "delivery",
      name: completed.name,
      owner: scope.owner,
      installationId: client.installationId,
      scopeId: scope.scopeId,
      nativeId: completed.id,
      delivered: true,
      completionId: notification.completionId,
      deliveredAt,
      ...(finishedAt !== undefined ? { finishedAt } : {}),
      ...(completed.exitCode !== undefined
        ? { remoteExitCode: completed.exitCode }
        : {}),
    };
    scope.deliveries.set(key, delivery);
    api.appendEntry(ENTRY_TYPE, delivery);
  }
  // The caller acknowledges upstream only after this accepted, persisted delivery
}
