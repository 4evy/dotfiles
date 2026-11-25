#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { output } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { object, or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { flag, option } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { Effect } from "effect";
import { parseDarwinOptions } from "../cli.ts";
import { clients } from "./clients.ts";
import { describeGrant, type Grant } from "./grants.ts";
import { notificationPermissions } from "./notifications/notifications.ts";
import { reconcileCaptureReminders } from "./replaykit.ts";
import * as tcc from "./tcc/tcc.ts";

const rootUid = 0;
const rootUsername = "root";

// Grant broadly only to declared clients, never to a directory's contents
// TCC grants do not replace entitlements, usage descriptions, or browser policy

const confirmTcc = Effect.fn(function* (user: string) {
  const confirmed = yield* Effect.tryPromise({
    try: async (signal) => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      const abort = () => prompt.close();
      signal.addEventListener("abort", abort, { once: true });
      try {
        process.stderr.write(
          `Insert only the listed TCC decisions for ${user}? Type yes: `,
        );
        for await (const answer of prompt) return answer.trim() === "yes";
        return false;
      } finally {
        prompt.close();
        signal.removeEventListener("abort", abort);
      }
    },
    catch: (cause) => new DotfilesError("Could not confirm TCC changes", { cause }),
  });
  if (!confirmed)
    return yield* Effect.fail(
      new DotfilesError("TCC changes not approved. No rows inserted"),
    );
});

type ReconcileOptions = {
  user: string;
  mode: "apply" | "check" | "dry-run";
  writeTcc: boolean;
  suppressReminders: boolean;
};

const canInspectTcc = Effect.fn(function* ({
  mode,
  writeTcc,
  suppressReminders,
}: ReconcileOptions) {
  if (writeTcc && (!process.stdin.isTTY || !process.stderr.isTTY))
    return yield* Effect.fail(
      new DotfilesError("--tcc requires an interactive terminal"),
    );
  if (process.platform !== "darwin")
    return yield* Effect.fail(new DotfilesError("TCC permissions require macOS"));
  if (process.getuid?.() !== rootUid)
    return yield* Effect.fail(
      new DotfilesError("Run with sudo to access both TCC databases"),
    );
  const sip = yield* output(["/usr/bin/csrutil", "status"]);
  if (!sip.includes("status: disabled.")) {
    if (mode === "check" || writeTcc || suppressReminders)
      return yield* Effect.fail(
        new DotfilesError(
          "Cannot inspect private macOS permission stores with SIP enabled",
        ),
      );
    console.log("Skipping macOS permissions: SIP is not disabled. No changes made");
    return false;
  }
  return true;
});

const resolveAccount = Effect.fn(function* (user: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(user) || user === rootUsername)
    return yield* Effect.fail(new DotfilesError("Expected a non-root local username"));
  const account = yield* output([
    "/usr/bin/dscl",
    ".",
    "-read",
    `/Users/${user}`,
    "NFSHomeDirectory",
    "UniqueID",
  ]);
  const home = account.match(/^NFSHomeDirectory: (.+)$/m)?.[1];
  const uid = account.match(/^UniqueID: (\d+)$/m)?.[1];
  if (!home?.startsWith("/") || !uid)
    return yield* Effect.fail(new DotfilesError(`Could not resolve account: ${user}`));
  return { home, uid };
});

function printProposedInserts(plans: { path: string; missing: Grant[] }[]) {
  for (const plan of plans)
    for (const grant of plan.missing)
      console.error(
        `Proposed insert (${plan.path}): ${describeGrant(grant)} ` +
          `[authorization ${grant.authValue}, version ${grant.authVersion}]`,
      );
}

const reconcile = Effect.fn(function* (options: ReconcileOptions) {
  if (!(yield* canInspectTcc(options))) return;
  const { user, mode, writeTcc, suppressReminders } = options;
  const { home, uid } = yield* resolveAccount(user);
  const userPath = yield* tcc.userDatabase(uid, home);
  const discovered = yield* clients(home, uid, user);
  const installed = discovered.filter((client) => client.grantPermissions);
  const targets = discovered.filter((client) => client.bundle);
  const notifications = notificationPermissions(
    installed.flatMap((client) =>
      client.bundleIdentifier ? [client.bundleIdentifier] : [],
    ),
    user,
    uid,
    home,
    mode,
  );
  if (mode === "dry-run") {
    for (const client of installed) console.log(`Managed client: ${client.identifier}`);
  }
  const changes = yield* tcc.inspect(
    installed,
    targets,
    userPath,
    writeTcc ? "apply" : mode === "apply" ? "inspect" : mode,
  );
  if (changes.missing > 0 && writeTcc) {
    printProposedInserts(changes.plans);
    yield* confirmTcc(user);
    yield* changes.apply(uid);
  } else if (changes.missing > 0) {
    console.log(
      "Missing decisions may be deliberate resets. Use the app's permission prompt or System Settings, or review inserts with --tcc",
    );
  }
  if (suppressReminders && changes.captureClients.length === 0)
    console.log("No matching stored screen capture decisions. ReplayKit unchanged");
  const approvalCount = suppressReminders
    ? yield* reconcileCaptureReminders(changes.captureClients, home, uid, user, mode)
    : 0;
  const notificationCount = yield* notifications;
  if (
    mode === "check" &&
    changes.persistentDrift + approvalCount + notificationCount > 0
  )
    return yield* Effect.fail(
      new DotfilesError(
        `${changes.persistentDrift} persistent TCC decisions missing or conflicting, ${approvalCount} selected screen capture reminders and ${notificationCount} notification grants differ`,
      ),
    );
});

const parser = object({
  user: option("--user", string({ metavar: "USER" }))
    .multiple()
    .map((values) => values.at(-1) ?? process.env.SUDO_USER ?? process.env.USER),
  mode: or(
    flag("--check")
      .multiple({ min: 1 })
      .map(() => "check" as const),
    flag("--dry")
      .multiple({ min: 1 })
      .map(() => "dry-run" as const),
  ).withDefault("apply"),
  writeTcc: flag("--tcc", {
    description: message`Review and confirm missing TCC inserts in this terminal`,
  })
    .map(() => true)
    .withDefault(false),
  suppressReminders: flag("--reminders", {
    description: message`Opt in to private ReplayKit reminder changes for matching stored capture decisions`,
  })
    .map(() => true)
    .withDefault(false),
});

if (import.meta.main)
  runMain(
    Effect.gen(function* () {
      const values = yield* Effect.try({
        try: () =>
          parseDarwinOptions(
            parser,
            "dotfiles-permissions",
            Bun.argv.slice(2),
            message`Inspect macOS TCC decisions and reconcile declared notification preferences`,
            message`TCC is read-only unless you review and confirm --tcc. A stored match does not establish effective access`,
          ),
        catch: (cause) => new DotfilesError(String(cause)),
      });
      if (!values) return;
      if (!values.user)
        return yield* Effect.fail(
          new DotfilesError("Specify --user and at most one check mode"),
        );
      if (values.writeTcc && values.mode !== "apply")
        return yield* Effect.fail(
          new DotfilesError("--tcc cannot be combined with --check or --dry"),
        );
      yield* reconcile({ ...values, user: values.user });
    }),
  );
