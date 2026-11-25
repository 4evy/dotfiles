import type { Database } from "bun:sqlite";
import { DotfilesError } from "@dotfiles/core/errors";
import policy from "@dotfiles/repo/data/macos/permissions";
import { type Access, type Grant, type GrantKey, targetType } from "../grants.ts";
import { tccAnyTarget, tccNoTarget } from "../schema.ts";

export type StoredDecision = {
  exact: Access | undefined;
  overlap: boolean;
  managed: boolean;
};

type AccessColumn = {
  name: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  hidden: 0 | 1 | 2 | 3;
};

// pragma_table_xinfo uses nonzero values for hidden or generated columns
const normalColumn = 0;

// Fields supplied by the grant writer, not a declaration of Apple's schema
const writeColumns = [
  "service",
  "client",
  "client_type",
  "auth_value",
  "auth_reason",
  "auth_version",
  "csreq",
  "policy_id",
  "indirect_object_identifier_type",
  "indirect_object_identifier",
  "indirect_object_code_identity",
  "flags",
  "last_modified",
] as const;

export function prepareLookup(db: Database) {
  // Treat overlapping rows as possible decisions, not as effective-access proof
  const accessRows = db.prepare<
    Access,
    [
      service: GrantKey["service"],
      client: GrantKey["client"],
      clientType: GrantKey["clientType"],
      target: GrantKey["target"],
      anyTarget: typeof tccAnyTarget,
      noTarget: typeof tccNoTarget,
    ]
  >(`
    SELECT auth_value AS authValue, auth_reason AS authReason, auth_version AS authVersion,
           csreq, policy_id AS policyId, flags, last_modified AS lastModified,
           indirect_object_identifier_type AS indirectObjectIdentifierType,
           indirect_object_identifier AS indirectObjectIdentifier,
           indirect_object_code_identity AS indirectObjectCodeIdentity
    FROM main.access
    WHERE service = ?1 AND client = ?2 AND client_type = ?3
      AND (indirect_object_identifier IN (?4, ?5, ?6) OR ?4 = ?6)
  `);
  // Some TCC schemas omit this table. Where present, tccd probes it by client
  // and service without an indirect target. Treat a hit as a possible conflict
  const managed = db
    .query(
      "SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'managed_overrides'",
    )
    .get()
    ? db.prepare<{ present: 1 }, [string, string, number]>(
        "SELECT 1 AS present FROM main.managed_overrides WHERE service = ? AND client = ? AND client_type = ? LIMIT 1",
      )
    : undefined;
  return (key: GrantKey): StoredDecision => {
    const rows = accessRows.all(
      key.service,
      key.client,
      key.clientType,
      key.target,
      tccAnyTarget,
      tccNoTarget,
    );
    let exact: Access | undefined;
    let overlap = false;
    for (const row of rows) {
      if (row.indirectObjectIdentifier === key.target) exact ??= row;
      else overlap = true;
      if (exact && overlap) break;
    }
    return {
      exact,
      overlap,
      managed: managed?.get(key.service, key.client, key.clientType) != null,
    };
  };
}

export function validateWrites(db: Database) {
  const columns = db
    .query<AccessColumn, []>(
      `SELECT name, "notnull", dflt_value, hidden FROM pragma_table_xinfo('access', 'main')`,
    )
    .all();
  const writable = new Map<string, AccessColumn>();
  for (const column of columns) {
    if (column.hidden === normalColumn) writable.set(column.name.toLowerCase(), column);
  }
  for (const name of writeColumns) {
    if (!writable.delete(name))
      throw new DotfilesError(
        `${db.filename}: access.${name} is not a writable column`,
      );
  }
  for (const { name, notnull, dflt_value } of writable.values()) {
    if (notnull && (dflt_value === null || /^[\s()]*null[\s()]*$/i.test(dflt_value)))
      throw new DotfilesError(
        `${db.filename}: access.${name} requires a value with no usable default`,
      );
  }
}

export function prepareInsert(db: Database) {
  const insert = db.prepare(
    `INSERT INTO main.access (${writeColumns.join(", ")}) VALUES (${writeColumns.map(() => "?").join(", ")})`,
  );
  return (grant: Grant, key: GrantKey, lastModified: number) => {
    insert.run(
      key.service,
      key.client,
      key.clientType,
      grant.authValue,
      policy.authorization.reason,
      grant.authVersion,
      grant.client.requirement,
      null,
      targetType(grant),
      key.target,
      grant.target?.requirement ?? null,
      policy.authorization.flags,
      lastModified,
    );
  };
}
