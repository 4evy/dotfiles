import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import policy from "@dotfiles/repo/data/macos/permissions";
import { and, eq, ne, placeholder } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, FileSystem } from "effect";
import type { Client } from "./clients.ts";
import type { Access, Grant } from "./grants.ts";
import { grantFor, matches, plansFor } from "./grants.ts";
import { access, tccNoTarget, tccNoTargetType, tccServicePrefix } from "./schema.ts";

export type TccPlan = {
  path: string;
  db: BunSQLiteDatabase & { $client: Database };
  select: {
    get(placeholderValues?: Record<string, unknown>): Access | undefined;
  };
  pending: Grant[];
  deletions: Access[];
};

export type TccChanges = {
  plans: TccPlan[];
  count: number;
  persistentCount: number;
};

const millisecondsPerSecond = 1000;
const backupDirectoryMode = 0o700;
const backupFileMode = 0o600;
const tccDaemon = "tccd";
const lsofPathField = "n";
const lsofAbsolutePathPrefix = `${lsofPathField}/`;
const rootUid = "0";
const pgrep = "/usr/bin/pgrep";

const attempt = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (cause) => new DotfilesError(String(cause)),
  });

export const userDatabase = Effect.fn(function* (uid: string, home: string) {
  const fs = yield* FileSystem.FileSystem;
  const traditional = policy.databases.user.replaceAll("{home}", home);
  // macOS 27 stores user TCC in a per-user ProtectedSystem container
  const process = yield* run([pgrep, "-u", uid, "-x", tccDaemon], {
    capture: true,
    check: false,
  });
  for (const pid of process.stdout.trim().split(/\s+/).filter(Boolean)) {
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

function addExistingTargetGrants(
  db: TccPlan["db"],
  grants: Grant[],
  installed: Client[],
): void {
  for (const service of policy.services.existingTargets) {
    const identities = db
      .selectDistinct({
        identifier: access.indirectObjectIdentifier,
        type: access.indirectObjectIdentifierType,
        requirement: access.indirectObjectCodeIdentity,
      })
      .from(access)
      .where(
        and(
          eq(access.service, `${tccServicePrefix}${service}`),
          ne(access.indirectObjectIdentifier, tccNoTarget),
        ),
      )
      .all();
    for (const client of installed)
      for (const target of identities) grants.push(grantFor(service, client, target));
  }
}

function managedUnscopedRow(row: Access | undefined, client: Client): row is Access {
  return (
    row?.authReason === policy.authorization.reason &&
    row.flags === policy.authorization.flags &&
    (row.csreq === null
      ? client.requirement === null
      : client.requirement !== null && row.csreq.equals(client.requirement))
  );
}

function obsoleteRows(select: TccPlan["select"], installed: Client[]): Access[] {
  const deletions: Access[] = [];
  // Remove only the old blanket rows this policy previously managed
  for (const service of policy.services.retiredUnscoped) {
    for (const client of installed) {
      const row = select.get({
        service: `${tccServicePrefix}${service}`,
        client: client.identifier,
        clientType: client.type,
        target: tccNoTarget,
      });
      if (managedUnscopedRow(row, client)) deletions.push(row);
    }
  }
  return deletions;
}

function pendingGrants(select: TccPlan["select"], grants: Grant[]): Grant[] {
  // Refresh expired grants even when their authorization fields still match
  const now = Math.floor(Date.now() / millisecondsPerSecond);
  return grants.filter((grant) => {
    const row = select.get({
      service: grant.service,
      client: grant.client.identifier,
      clientType: grant.client.type,
      target: grant.target?.identifier ?? tccNoTarget,
    });
    return (
      !matches(row, grant) ||
      (grant.expirySeconds !== undefined &&
        row !== undefined &&
        now - row.lastModified >= grant.expirySeconds)
    );
  });
}

export const inspectTcc = Effect.fn(function* (
  installed: Client[],
  targets: Client[],
  userPath: string,
  mode: "apply" | "check" | "dry-run",
) {
  const plans = plansFor(installed, targets, userPath);
  const databases: Database[] = [];
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const db of databases) db.close();
    }),
  );
  const changes: TccPlan[] = yield* attempt(() =>
    plans.map((plan) => {
      // Only describe tccd's existing schema, never create or migrate it
      const db = drizzle({
        connection: {
          source: plan.path,
          create: false,
          ...(mode === "apply" ? { readwrite: true } : { readonly: true }),
        },
      });
      databases.push(db.$client);
      // Preparing every modeled column rejects incompatible schemas before writes
      const select = db
        .select()
        .from(access)
        .where(
          and(
            eq(access.service, placeholder("service")),
            eq(access.client, placeholder("client")),
            eq(access.clientType, placeholder("clientType")),
            eq(access.indirectObjectIdentifier, placeholder("target")),
          ),
        )
        .prepare();
      let deletions: Access[] = [];
      if (plan.path === userPath) {
        addExistingTargetGrants(db, plan.grants, installed);
        deletions = obsoleteRows(select, installed);
      }
      const pending = pendingGrants(select, plan.grants);
      const ephemeral = pending.filter((grant) => !grant.persistent).length;
      console.log(
        `${plan.path}: ${pending.length - ephemeral} persistent grants differ, ` +
          `${ephemeral} expiring grants to refresh, ${deletions.length} obsolete rows`,
      );
      return { ...plan, db, select, pending, deletions };
    }),
  );
  const count = changes.reduce(
    (total, plan) => total + plan.pending.length + plan.deletions.length,
    0,
  );
  const persistentCount = changes.reduce(
    (total, plan) =>
      total +
      plan.pending.filter((grant) => grant.persistent).length +
      plan.deletions.length,
    0,
  );
  return { plans: changes, count, persistentCount };
});

const applyPlan = Effect.fn(function* (plan: TccPlan) {
  yield* attempt(() =>
    plan.db.transaction(
      (tx) => {
        const update = {
          authValue: placeholder("authValue").getSQL(),
          authReason: policy.authorization.reason,
          authVersion: placeholder("authVersion").getSQL(),
          csreq: placeholder("csreq").getSQL(),
          policyId: null,
          indirectObjectIdentifierType: placeholder("targetType").getSQL(),
          indirectObjectCodeIdentity: placeholder("targetRequirement").getSQL(),
          flags: policy.authorization.flags,
          lastModified: Math.floor(Date.now() / millisecondsPerSecond),
        };
        const upsert = tx
          .insert(access)
          .values({
            ...update,
            service: placeholder("service"),
            client: placeholder("client"),
            clientType: placeholder("clientType"),
            indirectObjectIdentifier: placeholder("target"),
          })
          .onConflictDoUpdate({
            target: [
              access.service,
              access.client,
              access.clientType,
              access.indirectObjectIdentifier,
            ],
            set: update,
          })
          .prepare();
        const remove = tx
          .delete(access)
          .where(
            and(
              eq(access.service, placeholder("service")),
              eq(access.client, placeholder("client")),
              eq(access.clientType, placeholder("clientType")),
              eq(access.indirectObjectIdentifier, placeholder("target")),
            ),
          )
          .prepare();
        for (const row of plan.deletions)
          remove.run({
            service: row.service,
            client: row.client,
            clientType: row.clientType,
            target: row.indirectObjectIdentifier,
          });
        for (const grant of plan.pending)
          upsert.run({
            service: grant.service,
            client: grant.client.identifier,
            clientType: grant.client.type,
            authValue: grant.authValue,
            authVersion: grant.authVersion,
            csreq: grant.client.requirement,
            targetType: grant.target ? grant.target.type : tccNoTargetType,
            target: grant.target?.identifier ?? tccNoTarget,
            targetRequirement: grant.target?.requirement ?? null,
          });
        for (const grant of plan.pending) {
          if (
            !matches(
              plan.select.get({
                service: grant.service,
                client: grant.client.identifier,
                clientType: grant.client.type,
                target: grant.target?.identifier ?? tccNoTarget,
              }),
              grant,
            )
          )
            throw new Error(
              `Could not verify ${grant.service} for ${grant.client.identifier}`,
            );
        }
      },
      { behavior: "immediate" },
    ),
  );
});

export const applyTcc = Effect.fn(function* (
  { plans, count }: TccChanges,
  uid: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const backup = join(policy.backups, new Date().toISOString().replaceAll(":", "-"));
  yield* fs.makeDirectory(backup, { recursive: true, mode: backupDirectoryMode });
  for (const [index, plan] of plans.entries()) {
    const path = join(backup, index === 0 ? "system.db" : `user-${uid}.db`);
    yield* fs.writeFile(path, yield* attempt(() => plan.db.$client.serialize()), {
      mode: backupFileMode,
    });
  }
  console.log(`TCC backups: ${backup}`);
  for (const plan of plans) yield* applyPlan(plan);
  // Restart only TCC daemons, not apps or input services, to discard cached denials
  for (const owner of [rootUid, uid]) {
    const pids = yield* run([pgrep, "-u", owner, "-x", tccDaemon], {
      capture: true,
      check: false,
    });
    const values = pids.stdout.trim().split(/\s+/).filter(Boolean);
    if (values.length > 0)
      yield* run(["/bin/kill", "-TERM", ...values], { capture: true });
  }
  console.log(`Applied ${count} TCC grants. Running apps may need relaunching`);
});
