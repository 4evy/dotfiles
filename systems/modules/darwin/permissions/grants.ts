import { DotfilesError } from "@dotfiles/core/errors";
import policy from "@dotfiles/repo/data/macos/permissions";
import type { Client } from "./clients.ts";
import {
  tccAnyTarget,
  tccClientTypes,
  tccNoTarget,
  tccNoTargetType,
  tccServicePrefix,
} from "./schema.ts";

export type Grant = {
  service: string;
  client: Client;
  target:
    | {
        identifier: string;
        type: number | null;
        requirement: Buffer | null;
      }
    | undefined;
  authValue: number;
  authVersion: number;
  expirySeconds: number | undefined;
};

type Target = NonNullable<Grant["target"]>;

// The projection consumed by grant matching, not the SQLite table schema
export type Access = {
  authValue: number;
  authReason: number;
  authVersion: number;
  csreq: Uint8Array | null;
  policyId: number | null;
  indirectObjectIdentifierType: number | null;
  indirectObjectIdentifier: string;
  indirectObjectCodeIdentity: Uint8Array | null;
  flags: number | null;
  lastModified: number;
};

const authorizationOverrides: Record<string, { value: number; version: number }> =
  policy.authorization.serviceOverrides;
const ephemeralExpiries = new Map(
  policy.services.ephemeral.map(({ service, expirySeconds }) => [
    service,
    expirySeconds,
  ]),
);

function grantFor(service: string, client: Client, target?: Target): Grant {
  const authorization = authorizationOverrides[service] ?? policy.authorization;
  const expirySeconds = ephemeralExpiries.get(service);
  return {
    service: `${tccServicePrefix}${service}`,
    client,
    target,
    authValue: authorization.value,
    authVersion: authorization.version,
    expirySeconds,
  };
}

const providerDomains: readonly {
  identifier: string;
  type: number | null;
  requirementHex: string | null;
}[] = policy.services.fileProviderDomains;

function explicitProviderTargets(): Target[] {
  return providerDomains.map(({ identifier, type, requirementHex }) => {
    if (
      !identifier ||
      identifier !== identifier.trim() ||
      identifier.includes("\0") ||
      identifier === tccNoTarget ||
      identifier === tccAnyTarget ||
      (type !== null && (!Number.isSafeInteger(type) || type < 0)) ||
      (requirementHex !== null && !/^(?:[0-9a-fA-F]{2})+$/.test(requirementHex))
    )
      throw new DotfilesError(
        `Invalid FileProviderDomain target: ${JSON.stringify(identifier)}`,
      );
    return {
      identifier,
      type,
      requirement: requirementHex === null ? null : Buffer.from(requirementHex, "hex"),
    };
  });
}

export type GrantKey = {
  service: string;
  client: string;
  clientType: number;
  target: string;
};

export function grantKey(grant: Grant): GrantKey {
  return {
    service: grant.service,
    client: grant.client.identifier,
    clientType: grant.client.type,
    target: grant.target?.identifier ?? tccNoTarget,
  };
}

export function describeGrant(grant: Grant): string {
  const { service, client, target } = grantKey(grant);
  return `${service.slice(tccServicePrefix.length)}: ${JSON.stringify(client)}${
    target === tccNoTarget ? "" : ` → ${JSON.stringify(target)}`
  }`;
}

export function targetType(grant: Grant): number | null {
  return grant.target ? grant.target.type : tccNoTargetType;
}

function equalRequirement(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null
    ? right === null
    : right !== null && Buffer.compare(left, right) === 0;
}

function collectGrant(
  plan: { path: string; grants: Map<string, Grant> },
  grant: Grant,
) {
  const { service, client, clientType, target } = grantKey(grant);
  if (grant.target && (target === tccNoTarget || target === tccAnyTarget))
    throw new DotfilesError(`Reserved TCC target: ${describeGrant(grant)}`);
  // The native primary key excludes both signing requirements and target type
  const key = JSON.stringify([service, client, clientType, target]);
  const previous = plan.grants.getOrInsert(key, grant);
  if (previous === grant) return;
  if (
    previous.authValue !== grant.authValue ||
    previous.authVersion !== grant.authVersion ||
    previous.expirySeconds !== grant.expirySeconds ||
    targetType(previous) !== targetType(grant) ||
    !equalRequirement(previous.client.requirement, grant.client.requirement) ||
    !equalRequirement(
      previous.target?.requirement ?? null,
      grant.target?.requirement ?? null,
    )
  ) {
    throw new DotfilesError(
      `Conflicting TCC plan for ${describeGrant(grant)} in ${plan.path}`,
    );
  }
}

function collectApplicationGrants(
  plan: { path: string; grants: Map<string, Grant> },
  subject: Client,
  targets: Client[],
) {
  for (const scoped of policy.services.applicationTargets)
    for (const receiver of targets)
      if (!scoped.signedOnly || receiver.type === tccClientTypes.bundleIdentifier)
        collectGrant(plan, grantFor(scoped.service, subject, receiver));
}

export function plansFor(
  installed: Client[],
  targets: Client[],
  userPath: string,
): { path: string; grants: Grant[] }[] {
  const providers = explicitProviderTargets();
  const system = { path: policy.databases.system, grants: new Map<string, Grant>() };
  const user = { path: userPath, grants: new Map<string, Grant>() };
  for (const subject of installed) {
    for (const name of policy.services.system)
      collectGrant(system, grantFor(name, subject));
    for (const name of policy.services.user)
      collectGrant(user, grantFor(name, subject));
    for (const ephemeral of policy.services.ephemeral)
      collectGrant(user, grantFor(ephemeral.service, subject));
    for (const target of providers)
      collectGrant(user, grantFor("FileProviderDomain", subject, target));
    collectApplicationGrants(user, subject, targets);
  }
  return [system, user].map(({ path, grants }) => ({
    path,
    grants: [...grants.values()],
  }));
}

export function matches(row: Access, grant: Grant): boolean {
  return (
    row.authValue === grant.authValue &&
    row.authVersion === grant.authVersion &&
    row.flags === policy.authorization.flags &&
    row.indirectObjectIdentifierType === targetType(grant) &&
    equalRequirement(row.csreq, grant.client.requirement) &&
    equalRequirement(row.indirectObjectCodeIdentity, grant.target?.requirement ?? null)
  );
}
