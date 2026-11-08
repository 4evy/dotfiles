import { blob, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// TCC's on-disk identity encoding and sentinel for unscoped grants
export const tccClientTypes = { bundleIdentifier: 0, absolutePath: 1 } as const;
export const tccNoTargetType = 0;
export const tccNoTarget = "UNUSED";
export const tccServicePrefix = "kTCCService";

// Describe Apple's existing table only, never create or migrate TCC databases
export const access = sqliteTable(
  "access",
  {
    service: text("service").notNull(),
    client: text("client").notNull(),
    clientType: integer("client_type").notNull(),
    authValue: integer("auth_value").notNull(),
    authReason: integer("auth_reason").notNull(),
    authVersion: integer("auth_version").notNull(),
    csreq: blob("csreq", { mode: "buffer" }),
    policyId: integer("policy_id"),
    indirectObjectIdentifierType: integer("indirect_object_identifier_type"),
    indirectObjectIdentifier: text("indirect_object_identifier").notNull(),
    indirectObjectCodeIdentity: blob("indirect_object_code_identity", {
      mode: "buffer",
    }),
    flags: integer("flags"),
    lastModified: integer("last_modified").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.service,
        table.client,
        table.clientType,
        table.indirectObjectIdentifier,
      ],
    }),
  ],
);
