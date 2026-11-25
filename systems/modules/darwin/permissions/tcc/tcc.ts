import { Database } from "bun:sqlite";
import { join } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import policy from "@dotfiles/repo/data/macos/permissions";
import { Effect, FileSystem } from "effect";
import type { Client } from "../clients.ts";
import type { Grant } from "../grants.ts";
import { describeGrant, grantKey, matches, plansFor } from "../grants.ts";
import { tccServicePrefix } from "../schema.ts";
import { type Baseline, compareSchema, createBaseline } from "./baseline.ts";
import { prepareInsert, prepareLookup, type StoredDecision } from "./store.ts";

type Plan = {
  path: string;
  db: Database;
  lookup: ReturnType<typeof prepareLookup>;
  insert: ReturnType<typeof prepareInsert> | undefined;
  missing: Grant[];
};

export type Mode = "apply" | "check" | "dry-run" | "inspect";

const millisecondsPerSecond = 1000;
const backupDirectoryMode = 0o700;
const backupFileMode = 0o600;
const daemon = "tccd";
const lsofPathField = "n";
const lsofAbsolutePathPrefix = `${lsofPathField}/`;
const rootUid = "0";
const pgrepNoMatches = 1;
const screenCaptureService = `${tccServicePrefix}ScreenCapture`;

const findDaemons = (uid: string) =>
  run(["/usr/bin/pgrep", "-u", uid, "-x", daemon], { capture: true, check: false });
const readPids = (stdout: string) => stdout.match(/\S+/g) ?? [];
const unixSeconds = () => Math.floor(Date.now() / millisecondsPerSecond);

const attempt = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (cause) => new DotfilesError(String(cause)),
  });

export const userDatabase = Effect.fn(function* (uid: string, home: string) {
  const fs = yield* FileSystem.FileSystem;
  const traditional = policy.databases.user.replaceAll("{home}", home);
  // Discover the user daemon's open file rather than assume a container path
  const process = yield* findDaemons(uid);
  for (const pid of readPids(process.stdout)) {
    const handles = yield* output(["/usr/sbin/lsof", "-a", "-p", pid, "-Fn"]);
    const paths = handles
      .split("\n")
      .filter(
        (line) =>
          line.startsWith(lsofAbsolutePathPrefix) &&
          line.endsWith(policy.databases.suffix),
      );
    const [path] = paths;
    if (paths.length === 1 && path) return path.slice(lsofPathField.length);
  }
  if (yield* fs.exists(traditional)) return traditional;
  return yield* Effect.fail(
    new DotfilesError(
      "No existing user TCC database found. Log in as the target user first",
    ),
  );
});

function isCurrentMatch(decision: StoredDecision, grant: Grant, now: number) {
  const { exact, overlap, managed } = decision;
  if (overlap || managed || !exact || !matches(exact, grant)) return false;
  if (
    grant.expirySeconds !== undefined &&
    now - exact.lastModified >= grant.expirySeconds
  )
    return false;
  return true;
}

function reportGrant(enabled: boolean, label: string, grant: Grant) {
  if (enabled) console.log(`${label}: ${describeGrant(grant)}`);
}

function reviewGrants(
  { path, lookup, missing }: Pick<Plan, "path" | "lookup" | "missing">,
  grants: Grant[],
  mode: Mode,
  now: number,
  captureClients: Client[],
) {
  const reportMissing = mode === "dry-run";
  const reportConflicts = reportMissing || mode === "check";
  let matching = 0;
  let preserved = 0;
  let persistentDrift = 0;
  for (const grant of grants) {
    const decision = lookup(grantKey(grant));
    if (isCurrentMatch(decision, grant, now)) {
      matching++;
      if (grant.service === screenCaptureService) captureClients.push(grant.client);
      continue;
    }
    if (grant.expirySeconds === undefined) persistentDrift++;
    if (decision.exact || decision.overlap || decision.managed) {
      preserved++;
      reportGrant(reportConflicts, "Preserved conflict", grant);
      continue;
    }
    missing.push(grant);
    reportGrant(reportMissing, "Missing decision", grant);
  }
  console.log(
    `${path}: ${matching} stored matches, ${preserved} preserved conflicts, ` +
      `${missing.length} missing decisions. Effective access not checked`,
  );
  return persistentDrift;
}

const openDatabase = (path: string, readonly: boolean) =>
  Effect.acquireRelease(
    attempt(() => new Database(path, { create: false, readonly, strict: true })),
    (db) => Effect.sync(() => db.close()),
  );

export const inspect = Effect.fn(function* (
  installed: Client[],
  targets: Client[],
  userPath: string,
  mode: Mode,
) {
  const fs = yield* FileSystem.FileSystem;
  const plans = yield* attempt(() => plansFor(installed, targets, userPath));
  const systemPath = yield* fs.realPath(policy.databases.system);
  if (systemPath === (yield* fs.realPath(userPath)))
    return yield* Effect.fail(
      new DotfilesError("System and user TCC database paths resolve to the same file"),
    );
  const baseline = yield* attempt(() => createBaseline(mode === "apply"));

  let missingCount = 0;
  let persistentDrift = 0;
  const captureClients: Client[] = [];
  const now = unixSeconds();
  const changes: Plan[] = [];
  for (const { path, grants } of plans) {
    const db = yield* openDatabase(path, mode !== "apply");
    const plan = yield* attempt(() => {
      compareSchema(db, baseline);
      const prepared: Plan = {
        path,
        db,
        lookup: prepareLookup(db),
        insert: mode === "apply" ? prepareInsert(db) : undefined,
        missing: [],
      };
      persistentDrift += reviewGrants(prepared, grants, mode, now, captureClients);
      return prepared;
    });
    missingCount += plan.missing.length;
    changes.push(plan);
  }
  return {
    plans: changes,
    missing: missingCount,
    persistentDrift,
    captureClients,
    apply: (uid: string) => applyChanges(changes, uid, baseline),
  };
});

const applyPlan = (plan: Plan, baseline: Baseline) =>
  attempt(() =>
    plan.db
      .transaction(() => {
        const { insert } = plan;
        if (!insert) throw new Error(`TCC plan was opened read-only: ${plan.path}`);
        compareSchema(plan.db, baseline);
        const lastModified = unixSeconds();
        let inserted = 0;
        for (const grant of plan.missing) {
          const key = grantKey(grant);
          // Preserve decisions made while the operator reviewed the plan
          const { exact, overlap, managed } = plan.lookup(key);
          if (exact || overlap || managed) {
            console.log(`Preserved new decision: ${describeGrant(grant)}`);
            continue;
          }
          insert(grant, key, lastModified);
          const saved = plan.lookup(key).exact;
          if (
            !saved ||
            !matches(saved, grant) ||
            saved.authReason !== policy.authorization.reason ||
            saved.policyId !== null ||
            saved.lastModified !== lastModified
          )
            throw new Error(`Could not verify TCC insert: ${describeGrant(grant)}`);
          inserted++;
        }
        return inserted;
      })
      .immediate(),
  );

const applyChanges = Effect.fn(function* (
  plans: Plan[],
  uid: string,
  baseline: Baseline,
) {
  const fs = yield* FileSystem.FileSystem;
  const pending = plans.filter((plan) => plan.missing.length > 0);
  if (pending.length === 0) return;
  const backup = join(policy.backups, new Date().toISOString().replaceAll(":", "-"));
  yield* fs.makeDirectory(backup, { recursive: true, mode: backupDirectoryMode });
  for (const plan of pending) {
    const path = join(
      backup,
      plan.path === policy.databases.system ? "system.db" : `user-${uid}.db`,
    );
    yield* fs.writeFile(path, yield* attempt(() => plan.db.serialize()), {
      mode: backupFileMode,
    });
  }
  console.log(`TCC backups: ${backup}`);
  const committed: string[] = [];
  for (const plan of pending) {
    const inserted = yield* applyPlan(plan, baseline).pipe(
      Effect.mapError((error) => {
        const previous =
          committed.length === 0
            ? "No TCC database committed"
            : `Already committed: ${committed.join(", ")}`;
        return new DotfilesError(
          `${plan.path}: ${error.message}. ${previous}. Daemons not refreshed`,
        );
      }),
    );
    if (inserted === 0) continue;
    committed.push(plan.path);
    console.log(`${plan.path}: committed ${inserted} new TCC decisions`);
  }
  if (committed.length === 0) return;
  yield* refreshDaemons(committed, uid);
  console.log("Stored TCC decisions changed. Running apps may need relaunching");
});

const refreshDaemons = Effect.fn(function* (committed: string[], uid: string) {
  // Leave already committed rows intact if a daemon refresh fails
  const owners = committed.map((path) =>
    path === policy.databases.system ? rootUid : uid,
  );
  for (const owner of owners) {
    const pids = yield* findDaemons(owner);
    if (pids.code !== 0 && pids.code !== pgrepNoMatches)
      return yield* Effect.fail(
        new DotfilesError(
          `TCC committed, but could not find the daemon for UID ${owner}: ${pids.stderr.trim()}`,
        ),
      );
    const values = readPids(pids.stdout);
    if (values.length > 0)
      yield* run(["/bin/kill", "-TERM", ...values], { capture: true }).pipe(
        Effect.mapError(
          (error) =>
            new DotfilesError(
              `TCC committed, but daemon refresh failed for UID ${owner}: ${error.message}`,
            ),
        ),
      );
  }
});
