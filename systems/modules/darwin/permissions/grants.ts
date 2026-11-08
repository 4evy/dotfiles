import policy from "@dotfiles/repo/data/macos/permissions";
import type { Client } from "./clients.ts";
import type { access } from "./schema.ts";

export type Target = {
  identifier: string;
  type: number | null;
  requirement: Buffer | null;
};

export type Grant = {
  service: string;
  client: Client;
  target: Target | undefined;
  authValue: number;
  authVersion: number;
  persistent: boolean;
  expirySeconds: number | undefined;
};

export type Access = typeof access.$inferSelect;

const authorizationOverrides: Record<string, { value: number; version: number }> =
  policy.authorization.serviceOverrides;
const ephemeralExpiries = new Map(
  policy.services.ephemeral.map(({ service, expirySeconds }) => [
    service,
    expirySeconds,
  ]),
);

export function grantFor(service: string, client: Client, target?: Target): Grant {
  const authorization = authorizationOverrides[service] ?? policy.authorization;
  const expirySeconds = ephemeralExpiries.get(service);
  return {
    service: `kTCCService${service}`,
    client,
    target,
    authValue: authorization.value,
    authVersion: authorization.version,
    persistent: expirySeconds === undefined,
    expirySeconds,
  };
}

export function plansFor(
  installed: Client[],
  targets: Client[],
  userPath: string,
): { path: string; grants: Grant[] }[] {
  return [
    {
      path: policy.databases.system,
      grants: installed.flatMap((client) =>
        policy.services.system.map((service) => grantFor(service, client)),
      ),
    },
    {
      path: userPath,
      grants: installed.flatMap((client) => [
        ...policy.services.user.map((service) => grantFor(service, client)),
        ...policy.services.ephemeral.map(({ service }) => grantFor(service, client)),
        ...policy.services.applicationTargets.flatMap(({ service, signedOnly }) =>
          targets
            .filter((target) => !signedOnly || target.type === 0)
            .map((target) => grantFor(service, client, target)),
        ),
      ]),
    },
  ];
}

export function matches(row: Access | undefined, grant: Grant): boolean {
  const equal = (actual: Uint8Array | null, expected: Uint8Array | null | undefined) =>
    expected == null
      ? actual === null
      : actual !== null && Buffer.from(actual).equals(expected);
  return (
    row !== undefined &&
    row.authValue === grant.authValue &&
    row.authReason === policy.authorization.reason &&
    row.authVersion === grant.authVersion &&
    row.policyId === null &&
    row.flags === policy.authorization.flags &&
    row.indirectObjectIdentifierType === (grant.target ? grant.target.type : 0) &&
    equal(row.csreq, grant.client.requirement) &&
    equal(row.indirectObjectCodeIdentity, grant.target?.requirement)
  );
}
