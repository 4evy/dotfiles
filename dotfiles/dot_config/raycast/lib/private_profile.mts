import { z } from "zod";

import { PATHS } from "./config.mts";
import type { RaycastDatabaseClient } from "./types.mts";
import { requiredString } from "./util.mts";

export type RaycastProfilePayload = {
  currentUser: Record<string, unknown> & { id: string; name: string };
};

export const PROFILE_USER_DEFAULTS = PATHS.profileUserDefaults;

export function parseProfilePayload(
  currentUser: string | undefined,
): RaycastProfilePayload {
  return {
    currentUser: z
      .looseObject({ id: z.string().min(1), name: z.string().min(1) })
      .parse(JSON.parse(requiredString(currentUser, "current user JSON"))),
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
  await db.userDefaults.delete(PROFILE_USER_DEFAULTS.oauthToken);
  await db.userDefaults.delete("AuthSessionExpired");

  const stored = await db.userDefaults.get(PROFILE_USER_DEFAULTS.currentUser);
  if (typeof stored !== "string")
    throw new Error("CurrentUser was not stored as JSON text");
  return parseProfilePayload(stored).currentUser;
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
