import { PATHS } from "./config.mts";
import type { RaycastDatabaseClient } from "./types.mts";
import { parseJsonObject, requiredString } from "./util.mts";

export type RaycastProfilePayload = {
  currentUser: Record<string, unknown> & { id: string; name: string };
  oauthToken: Record<string, unknown> & { access_token: string };
};

export const PROFILE_USER_DEFAULTS = PATHS.profileUserDefaults;

export function parseProfilePayload(
  currentUser: string | undefined,
  oauthToken: string | undefined,
): RaycastProfilePayload {
  const user = parseJsonObject(
    requiredString(currentUser, "current user JSON"),
    "current user",
  );
  const token = parseJsonObject(
    requiredString(oauthToken, "OAuth token JSON"),
    "OAuth token",
  );

  return {
    currentUser: {
      ...user,
      id: requiredString(user.id, "current user id"),
      name: requiredString(user.name, "current user name"),
    },
    oauthToken: {
      ...token,
      access_token: requiredString(token.access_token, "OAuth access_token"),
    },
  };
}

export async function applyProfileDefaults(
  db: RaycastDatabaseClient,
  profile: RaycastProfilePayload,
): Promise<RaycastProfilePayload["currentUser"]> {
  await db.userDefaults.set(
    PROFILE_USER_DEFAULTS.currentUser,
    JSON.stringify(profile.currentUser),
  );
  await db.userDefaults.set(
    PROFILE_USER_DEFAULTS.oauthToken,
    JSON.stringify(profile.oauthToken),
  );

  const stored = await db.userDefaults.get(PROFILE_USER_DEFAULTS.currentUser);
  if (typeof stored !== "string")
    throw new Error("CurrentUser was not stored as JSON text");
  return parseProfilePayload(stored, JSON.stringify(profile.oauthToken)).currentUser;
}

export function profileSummary(
  stored: { name: string } & Record<string, unknown>,
): string {
  const subscription = stored.subscription;
  const status =
    subscription && typeof subscription === "object" && "status" in subscription
      ? subscription.status
      : undefined;
  return `OK - ${stored.name} | pro:${stored.has_pro_features} | sub:${status}`;
}
