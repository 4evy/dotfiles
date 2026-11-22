import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import policy from "@dotfiles/repo/data/macos/permissions";
import { Effect, FileSystem } from "effect";
import type { Client } from "./clients.ts";

const lastAlerted = "kScreenCaptureApprovalLastAlerted";
const lastUsed = "kScreenCaptureApprovalLastUsed";
const privacyHint = "kScreenCapturePrivacyHintDate";

const captureReminderKeys = Effect.fn(function* (clients: readonly Client[]) {
  const fs = yield* FileSystem.FileSystem;
  const keys = new Set<string>();
  for (const { bundle, bundleIdentifier, grantPaths } of clients) {
    for (const path of grantPaths) {
      if (!bundle) {
        keys.add(path);
        continue;
      }
      const canonical = yield* fs.realPath(path);
      // ReplayKit uses bundle IDs in the standard app directories and URLs elsewhere
      const standard =
        canonical.startsWith("/Applications/") ||
        canonical.startsWith("/System/Applications/");
      keys.add(
        standard && bundleIdentifier
          ? bundleIdentifier
          : pathToFileURL(`${canonical}/`).href,
      );
    }
  }
  return keys;
});

export const reconcileCaptureReminders = Effect.fn(function* (
  clients: readonly Client[],
  home: string,
  uid: string,
  user: string,
  mode: "apply" | "check" | "dry-run",
) {
  if (clients.length === 0) return 0;

  const { domain, suppressUntil } = policy.replayKit;
  const path = join(home, domain);
  const defaults = [
    "/bin/launchctl",
    "asuser",
    uid,
    "/usr/bin/sudo",
    "-H",
    "-u",
    user,
    "/usr/bin/defaults",
  ];
  const keys = yield* captureReminderKeys(clients);

  const isCurrent = Effect.fn(function* (key: string) {
    const { code, stdout, stderr } = yield* run([...defaults, "read", path, key], {
      capture: true,
      check: false,
    });
    if (
      code === 1 &&
      (stderr.startsWith("Error: Could not find key ") ||
        stderr.trimEnd().endsWith("does not exist"))
    )
      return false;
    if (code !== 0)
      return yield* Effect.fail(
        new DotfilesError(`Cannot read ReplayKit approval: ${stderr.trim()}`),
      );
    // ReplayKit manages LastUsed itself once the app starts capturing
    return [lastAlerted, privacyHint].every((key) =>
      stdout.includes(`${key} = "${suppressUntil}";`),
    );
  });

  const pending: string[] = [];
  for (const key of keys) {
    if (!(yield* isCurrent(key))) pending.push(key);
  }
  for (const key of pending) {
    console.log(`ReplayKit reminder differs: ${key}`);
  }
  if (mode !== "apply" || pending.length === 0) return pending.length;

  // ReplayKit's private reminder store is independent of TCC's capture grant
  const dates = [lastAlerted, lastUsed, privacyHint].flatMap((key) => [
    key,
    "-date",
    suppressUntil,
  ]);
  for (const key of pending) {
    yield* run([...defaults, "write", path, key, "-dict-add", ...dates], {
      capture: true,
    });
    if (!(yield* isCurrent(key)))
      return yield* Effect.fail(
        new DotfilesError(`ReplayKit approval did not persist: ${key}`),
      );
  }
  const reload = yield* run(["/usr/bin/pkill", "-HUP", "-u", uid, "-x", "replayd"], {
    capture: true,
    check: false,
  });
  // No matching daemon is fine because its next launch reads the store
  if (reload.code !== 0 && (reload.code !== 1 || reload.stderr)) {
    return yield* Effect.fail(
      new DotfilesError(`Cannot reload ReplayKit: ${reload.stderr.trim()}`),
    );
  }
  console.log(`Updated ${pending.length} ReplayKit reminder records`);
  return pending.length;
});
