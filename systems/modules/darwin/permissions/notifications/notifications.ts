import { join } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import policy from "@dotfiles/repo/data/macos/permissions";
import { Effect, FileSystem, Schema } from "effect";

const reportSchema = Schema.Struct({
  pending: Schema.Number,
  registered: Schema.Number,
  unregistered: Schema.Array(Schema.String),
  changes: Schema.Array(
    Schema.Struct({
      identifier: Schema.String,
      beforeFlags: Schema.String,
      afterFlags: Schema.String,
    }),
  ),
});
const verificationSchema = Schema.Struct({
  outOfScopeChanges: Schema.Number,
  managedChanges: Schema.Number,
});

const parse = Effect.fn(function* (text: string) {
  return yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      new DotfilesError("Invalid native notification response", { cause }),
  });
});

const waitForExit = Effect.fn(function* (pid: number) {
  const deadline = Date.now() + 10_000;
  while (true) {
    const exited = yield* Effect.try({
      try: () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
            return true;
          throw cause;
        }
      },
      catch: (cause) =>
        new DotfilesError(`Could not observe usernoted PID ${pid}`, { cause }),
    });
    if (exited) return;
    if (Date.now() >= deadline)
      return yield* Effect.fail(
        new DotfilesError("Old notification daemon did not exit"),
      );
    yield* Effect.sleep(50);
  }
});

// macOS 27's daemon codec defines these full-width masks, not UNAuthorizationStatus
// Use the container-aware preferences API and never rewrite the plist behind cfprefsd
export const notificationPermissions = Effect.fn(function* (
  identifiers: string[],
  user: string,
  uid: string,
  home: string,
  mode: "apply" | "check" | "dry-run",
) {
  const settings = policy.notifications;
  const version = yield* output(["/usr/bin/sw_vers", "-productVersion"]);
  if (Number(version.split(".")[0]) !== settings.majorVersion)
    return yield* Effect.fail(
      new DotfilesError(`Notification encoding is not verified for macOS ${version}`),
    );
  const helper =
    process.env.DOTFILES_NOTIFICATIONS_HELPER ??
    join(import.meta.dir, "..", "bin", "dotfiles-notifications");
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(helper)))
    return yield* Effect.fail(
      new DotfilesError("Native notification helper is missing. Run just permissions"),
    );
  const container = settings.container.replaceAll("{home}", home);
  const request = {
    suite: settings.suite,
    container,
    identifiers: [...new Set(identifiers)].sort(),
    grants: Object.values(settings.grants),
  };
  const command = [
    "/bin/launchctl",
    "asuser",
    uid,
    "/usr/bin/sudo",
    "-H",
    "-u",
    user,
    helper,
  ];
  const inspect = Effect.fn(function* (action: "inspect" | "synchronize" | "apply") {
    const text = yield* output([...command, action], {
      input: JSON.stringify(request),
      timeout: 30,
    });
    return yield* Schema.decodeUnknownEffect(reportSchema)(yield* parse(text));
  });
  const initial = yield* inspect("inspect");
  console.log(
    `Notifications: ${initial.pending} grants differ, ${initial.registered} registered apps, ` +
      `${initial.unregistered.length} apps have no registered notification source`,
  );
  if (mode === "dry-run") {
    for (const change of initial.changes)
      console.log(`Notification grant: ${change.identifier}`);
    for (const identifier of initial.unregistered)
      console.log(`No notification source: ${identifier}`);
  }
  if (mode !== "apply" || initial.pending === 0) return initial.pending;
  if (!(yield* fs.exists(settings.agent)))
    return yield* Effect.fail(
      new DotfilesError(
        "Cannot stop usernoted without its original launch-agent plist",
      ),
    );

  const service = `gui/${uid}/${settings.service}`;
  // Install recovery before bootout, which can unload the job before failing
  yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      Effect.gen(function* () {
        yield* run(["/bin/launchctl", "bootout", service], { capture: true });
        const remaining = yield* run(
          ["/usr/bin/pgrep", "-u", uid, "-x", settings.processName],
          { capture: true, check: false },
        );
        if (remaining.code !== 0 && remaining.code !== 1)
          return yield* Effect.fail(
            new DotfilesError("Cannot verify notification daemon shutdown"),
          );
        for (const pid of remaining.stdout.trim().split(/\s+/).filter(Boolean))
          yield* waitForExit(Number(pid));
        // Flush the final shutdown writes before taking a physical backup
        yield* inspect("synchronize");
        const backup = join(
          settings.backups,
          new Date().toISOString().replaceAll(":", "-"),
        );
        yield* fs.makeDirectory(backup, { recursive: true, mode: 0o700 });
        const baseline = join(backup, "settings.plist");
        yield* fs.copyFile(
          join(container, "Library", "Preferences", `${settings.suite}.plist`),
          baseline,
        );
        yield* fs.chmod(baseline, 0o600);
        console.log(`Notification settings backup: ${backup}`);
        yield* inspect("apply");
        const persisted = yield* inspect("inspect");
        if (persisted.pending !== 0)
          return yield* Effect.fail(
            new DotfilesError("Notification authorization did not persist"),
          );
        const text = yield* output([helper, "verify"], {
          input: JSON.stringify({ ...request, baseline }),
          timeout: 30,
        });
        const verified = yield* Schema.decodeUnknownEffect(verificationSchema)(
          yield* parse(text),
        );
        if (verified.outOfScopeChanges !== 0)
          return yield* Effect.fail(
            new DotfilesError("Unrelated notification preferences changed"),
          );
        console.log(`Applied ${verified.managedChanges} scoped notification grants`);
      }),
    () =>
      Effect.gen(function* () {
        const loaded = yield* run(["/bin/launchctl", "print", service], {
          capture: true,
          check: false,
        });
        if (loaded.code !== 0)
          yield* run(["/bin/launchctl", "bootstrap", `gui/${uid}`, settings.agent], {
            capture: true,
          });
        yield* run(["/bin/launchctl", "kickstart", service], { capture: true });
      }),
  );
  const restarted = yield* inspect("inspect");
  if (restarted.pending !== 0)
    return yield* Effect.fail(
      new DotfilesError("Notification grants changed after daemon restart"),
    );
  return 0;
});
