import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Process } from "@oh-my-pi/pi-natives";
import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { z } from "zod";
import { deadlineEvidenceSchema } from "../../../../dotfiles/dot_omp/agent/lib/helper/jobs";
import { atomicWrite, privateDirectory, privateRead } from "../state";

const deadlineIndexSchema = z.strictObject({
  record: z.string(),
  nativeId: z.string(),
});

const recordSchema = z.strictObject({
  installationId: z.uuid(),
  scopeId: z.string().regex(/^[a-f0-9]{64}$/u),
  owner: z.string(),
  name: z.string(),
  evidence: deadlineEvidenceSchema,
});

async function persist(
  path: string,
  record: z.infer<typeof recordSchema>,
): Promise<void> {
  await atomicWrite(path, JSON.stringify(record));
  const root = dirname(path);
  for (const parent of [
    root,
    dirname(root),
    dirname(dirname(root)),
    dirname(dirname(dirname(root))),
  ]) {
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export async function prepareDeadline(
  directory: string,
  scopeId: string,
  owner: string,
  installationId: string,
  spec: DaemonSpec,
  deadlineSeconds: number,
): Promise<DaemonSpec> {
  if (deadlineSeconds === 0) return spec;
  const root = join(directory, "deadlines");
  await privateDirectory(root);
  const record = join(root, `${randomUUID()}.json`);
  await persist(record, {
    installationId,
    scopeId,
    owner,
    name: spec.name,
    evidence: { deadlineSeconds, preparedAt: Date.now(), childrenGone: "unknown" },
  });
  // The packaged executable re-enters this module without exposing command text
  const launcherArgs = Bun.main.startsWith("/$bunfs/") ? [] : [Bun.main];
  return {
    ...spec,
    application: process.execPath,
    args: [
      ...launcherArgs,
      "deadline",
      "--record",
      record,
      "--seconds",
      String(deadlineSeconds),
      "--application",
      spec.application,
      "--",
      ...spec.args,
    ],
  };
}

export async function bindDeadline(
  directory: string,
  spec: DaemonSpec,
  nativeId: string,
  installationId: string,
  scopeId: string,
  owner: string,
): Promise<void> {
  const marker = spec.args.indexOf("deadline");
  if (
    spec.application !== process.execPath ||
    marker < 0 ||
    spec.args[marker + 1] !== "--record"
  )
    return;
  const path = spec.args[marker + 2];
  if (!path || dirname(path) !== join(directory, "deadlines"))
    throw new Error("Invalid private deadline record location");
  const record = recordSchema.parse(JSON.parse(await privateRead(path)));
  if (
    record.installationId !== installationId ||
    record.scopeId !== scopeId ||
    record.owner !== owner ||
    record.name !== spec.name
  )
    throw new Error("Deadline evidence identity mismatch");
  const index = createHash("sha256")
    .update(JSON.stringify([spec.name, nativeId]))
    .digest("hex");
  await atomicWrite(
    join(directory, "deadlines", `${index}.index`),
    JSON.stringify({ record: path, nativeId }),
  );
}

export async function deadlineEvidence(
  directory: string,
  name: string,
  nativeId: string,
  installationId: string,
  scopeId: string,
  owner: string,
) {
  const root = join(directory, "deadlines");
  const index = createHash("sha256")
    .update(JSON.stringify([name, nativeId]))
    .digest("hex");
  try {
    const { record: path, nativeId: boundId } = deadlineIndexSchema.parse(
      JSON.parse(await privateRead(join(root, `${index}.index`))),
    );
    if (dirname(path) !== root) throw new Error("Invalid deadline evidence path");
    const record = recordSchema.parse(JSON.parse(await privateRead(path)));
    if (
      record.name !== name ||
      boundId !== nativeId ||
      record.installationId !== installationId ||
      record.scopeId !== scopeId ||
      record.owner !== owner
    )
      throw new Error("Deadline evidence identity mismatch");
    return record.evidence;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

export async function runDeadline(args: string[]): Promise<void> {
  if (
    args[0] !== "--record" ||
    args[2] !== "--seconds" ||
    args[4] !== "--application" ||
    args[6] !== "--"
  )
    throw new Error("Invalid managed deadline invocation");
  const path = args[1];
  const application = args[5];
  const seconds = Number(args[3]);
  if (
    !path ||
    resolve(path) !== path ||
    !application?.startsWith("/") ||
    !Number.isInteger(seconds) ||
    seconds <= 0
  )
    throw new Error("Invalid managed deadline arguments");
  await privateDirectory(dirname(path));
  const record = recordSchema.parse(JSON.parse(await privateRead(path)));
  if (record.evidence.deadlineSeconds !== seconds)
    throw new Error("Managed deadline identity mismatch");
  const evidence = record.evidence;
  evidence.startedAt = Date.now();
  await persist(path, record);
  // Inherit the broker's foreground PTY group so interactive reads never SIGTTIN
  const child = Bun.spawn([application, ...args.slice(7)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  let root: Process | null = null;
  try {
    root = Process.fromPid(child.pid);
  } catch {
    /* Child handle still enforces the deadline */
  }
  let exited = false;
  let tracked: Process[] = root ? [root] : [];
  const exit = child.exited.then((code) => {
    exited = true;
    return code;
  });
  const stop = new AbortController();
  const failed = Promise.withResolvers<never>();
  const watchdog = (async () => {
    try {
      await delay(seconds * 1000, undefined, { signal: stop.signal });
    } catch {
      return;
    }
    if (exited) return;
    if (root) {
      try {
        tracked = [root];
        for (const current of tracked) tracked.push(...current.children());
      } catch {
        evidence.nativeTreeSignalFailed = true;
      }
    }
    evidence.deadlineTriggeredAt = Date.now();
    await persist(path, record);
    let treeSignalled = false;
    try {
      treeSignalled = (root?.killTree(15) ?? 0) > 0;
    } catch {
      evidence.nativeTreeSignalFailed = true;
    }
    let signalSent = treeSignalled;
    if (!treeSignalled && !exited) {
      child.kill("SIGTERM");
      signalSent = true;
    }
    if (signalSent) evidence.signalSentAt = Date.now();
    await persist(path, record);
    await delay(1000);
    // Stable native references avoid signalling a PID reused after the leader exit
    let forceSent = false;
    for (const process of tracked) {
      try {
        if (process.status() !== "exited")
          forceSent = process.killTree(9) > 0 || forceSent;
      } catch {
        evidence.nativeTreeSignalFailed = true;
      }
    }
    if (!exited) {
      child.kill("SIGKILL");
      forceSent = true;
    }
    if (forceSent) evidence.forceSentAt = Date.now();
    await persist(path, record);
  })();
  void watchdog.catch(async () => {
    evidence.error = "deadline-enforcement-failed";
    if (!exited) {
      try {
        child.kill("SIGKILL");
        evidence.forceSentAt = Date.now();
      } catch {
        /* Report failure without claiming cleanup */
      }
    }
    try {
      await persist(path, record);
    } catch {
      /* The evidence store itself may be unavailable */
    }
    failed.reject(
      new Error("Managed deadline enforcement failed; child cleanup is not confirmed"),
    );
  });
  let exitCode: number;
  try {
    exitCode = await Promise.race([exit, failed.promise]);
    stop.abort();
    await watchdog;
  } finally {
    stop.abort();
  }
  evidence.exitCode = exitCode;
  evidence.leaderExited = true;
  if (tracked.length)
    evidence.trackedProcessesNoLongerObserved = tracked.every(
      (process) => process.status() === "exited",
    );
  await persist(path, record);
  process.exitCode = evidence.signalSentAt === undefined ? exitCode : 124;
}
