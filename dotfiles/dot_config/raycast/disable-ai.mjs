#!/usr/bin/env node
import process from "node:process";

import {
  applyDisabled,
  buildSnapshot,
  ensureBackup,
  restore,
  status,
} from "./lib/disable-ai.mjs";
import {
  backupPath,
  DEFAULT_APP_BUNDLE,
  DEFAULT_APP_SUPPORT,
  loadDatabase,
} from "./lib/raycast-database.mjs";

const FLAGS = new Set(["--dry-run", "--help", "-h", "--restore", "--status"]);

function printUsage() {
  console.log(`Usage: node disable-ai.mjs [--status] [--dry-run] [--restore]

Disables Raycast AI surfaces through Raycast's own local settings database:
- disables internal AI, Dictation, and Translator extensions
- clears Quick AI fallback command exposure
- disables MCP and file-search semantic indexing
- marks all Raycast AI models disabled
- clears selected/last-used AI model defaults
- clears Raycast AI/Dictation/Translator command frecency
- clears Raycast's AI chat window defaults

Environment:
  RAYCAST_APP_SUPPORT          default: ${DEFAULT_APP_SUPPORT}
  RAYCAST_APP_BUNDLE           default: ${DEFAULT_APP_BUNDLE}
  RAYCAST_KEY_FILE             default: latest node runtime .raycast-key-cache
  RAYCAST_AI_DISABLE_BACKUP    default: <app-support>/raycast-ai-disable-backup.json`);
}

function parseArgs(argv) {
  const unknown = argv.filter((flag) => !FLAGS.has(flag));
  if (unknown.length > 0) {
    throw new Error(`unknown option: ${unknown.join(", ")}`);
  }

  const args = {
    dryRun: argv.includes("--dry-run"),
    help: argv.includes("--help") || argv.includes("-h"),
    restore: argv.includes("--restore"),
    status: argv.includes("--status"),
  };

  if ([args.restore, args.status].filter(Boolean).length > 1) {
    throw new Error("--restore and --status cannot be used together");
  }

  return args;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const { db, appSupport, keyFile } = await loadDatabase();

  if (args.status) {
    console.log(JSON.stringify(await status(db), null, 2));
    return;
  }

  if (args.restore) {
    const changes = await restore(db, appSupport, backupPath, args.dryRun);
    console.log(
      JSON.stringify(
        { dryRun: args.dryRun, restored: changes.length, changes },
        null,
        2,
      ),
    );
    return;
  }

  const backup = backupPath(appSupport);
  const before = await buildSnapshot(db);
  const backupWritten = await ensureBackup(backup, before, args.dryRun);
  const changes = await applyDisabled(db, before, args.dryRun);

  console.log(
    JSON.stringify(
      {
        mode: "disable",
        dryRun: args.dryRun,
        keyFile,
        backup,
        backupWritten,
        operations: changes.length,
        status: await status(db),
      },
      null,
      2,
    ),
  );
}

run().catch((error) => {
  const message = process.env.DEBUG ? error.stack || error.message : error.message;
  console.error(`disable-ai: ${message}`);
  process.exitCode = 1;
});
