#!/usr/bin/env node
import process from "node:process";
import { parseArgs } from "node:util";

import { assertSupportedNode, PATHS } from "./lib/config.mts";
import { backupPath, withDatabase } from "./lib/db.mts";
import {
  applyDisabled,
  buildSnapshot,
  ensureBackup,
  restore,
  status,
} from "./lib/disable-ai.mts";
import { printJson, runCli } from "./lib/util.mts";

const FLAGS = {
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  restore: { type: "boolean" },
  status: { type: "boolean" },
} as const;

const USAGE = `Usage: node disable-ai.mts [--status] [--dry-run] [--restore]

Disables Raycast AI surfaces through Raycast's own local settings database:
- disables internal AI, Dictation, Translator, MCP, and Screen Awareness
- disables remote AI chat, local subscriptions, and agent search exposure
- resets tool permissions to confirmation and clears automatic approval rules
- clears Quick AI fallback command exposure
- clears AI skill directories and BYOK API keys
- disables file-search semantic indexing
- marks all Raycast AI models disabled
- clears Raycast AI/Dictation/Translator/Screen Awareness command frecency
- clears Raycast's AI chat window defaults

Environment:
  ${PATHS.env.appSupport}          default: ${PATHS.appSupport}
  ${PATHS.env.appBundle}           default: ${PATHS.appBundle}
  ${PATHS.env.keyFile}             default: latest node runtime ${PATHS.keyCacheName}
  ${PATHS.env.aiDisableBackup}    default: <app-support>/${PATHS.aiDisableBackupName}`;

async function run(): Promise<void> {
  assertSupportedNode();
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: FLAGS,
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.restore && values.status) {
    throw new Error("--restore and --status cannot be used together");
  }

  const dryRun = values["dry-run"] ?? false;
  await withDatabase(async ({ db, appSupport, keyFile }) => {
    if (values.status) {
      printJson(await status(db));
      return;
    }

    if (values.restore) {
      const changes = await restore(db, appSupport, backupPath, dryRun);
      printJson({ dryRun, restored: changes.length, changes });
      return;
    }

    const backup = backupPath(appSupport);
    const before = await buildSnapshot(db);
    const backupWritten = await ensureBackup(backup, before, dryRun);
    const changes = await applyDisabled(db, before, dryRun);
    printJson({
      mode: "disable",
      dryRun,
      keyFile,
      backup,
      backupWritten,
      operations: changes.length,
      changes,
      status: await status(db),
    });
  });
}

runCli("disable-ai", run);
