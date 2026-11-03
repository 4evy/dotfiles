#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { output } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect } from "effect";
import { clients } from "./clients.ts";
import { notificationPermissions } from "./notifications/notifications.ts";
import { applyTcc, inspectTcc, userDatabase } from "./tcc.ts";

// Grant broadly only to declared clients, never to a directory's contents
// TCC grants do not replace entitlements, usage descriptions, or browser policy

const reconcile = Effect.fn(function* (
  user: string,
  mode: "apply" | "check" | "dry-run",
) {
  if (process.platform !== "darwin")
    return yield* Effect.fail(new DotfilesError("TCC permissions require macOS"));
  if (process.getuid?.() !== 0)
    return yield* Effect.fail(
      new DotfilesError("Run with sudo to access both TCC databases"),
    );
  const sip = yield* output(["/usr/bin/csrutil", "status"]);
  if (!sip.includes("status: disabled."))
    return yield* Effect.fail(
      new DotfilesError("Direct TCC management requires SIP disabled. No changes made"),
    );
  if (!/^[a-zA-Z0-9_-]+$/.test(user) || user === "root")
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
  const userPath = yield* userDatabase(uid, home);
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
  const changes = yield* inspectTcc(installed, targets, userPath, mode);
  console.log(`${installed.length} clients, ${targets.length} AppleEvents targets`);
  if (mode !== "apply" || changes.count === 0) {
    const notificationCount = yield* notifications;
    if (mode === "check" && changes.persistentCount + notificationCount > 0)
      return yield* Effect.fail(
        new DotfilesError(
          `${changes.persistentCount} persistent TCC grants and ${notificationCount} notification grants differ. Run just permissions`,
        ),
      );
    return;
  }
  yield* applyTcc(changes, uid);
  yield* notifications;
});

if (import.meta.main)
  runMain(
    Effect.gen(function* () {
      const { values } = yield* Effect.try({
        try: () =>
          parseArgs({
            args: Bun.argv.slice(2),
            options: {
              user: {
                type: "string",
                default: process.env.SUDO_USER ?? process.env.USER,
              },
              check: { type: "boolean", default: false },
              "dry-run": { type: "boolean", default: false },
              help: { type: "boolean", short: "h" },
            },
          }),
        catch: (cause) => new DotfilesError(String(cause)),
      });
      if (values.help) {
        console.log("Usage: dotfiles-permissions --user USER [--check | --dry-run]");
        return;
      }
      if (!values.user || (values.check && values["dry-run"]))
        return yield* Effect.fail(
          new DotfilesError("Specify --user and at most one check mode"),
        );
      yield* reconcile(
        values.user,
        values.check ? "check" : values["dry-run"] ? "dry-run" : "apply",
      );
    }),
  );
