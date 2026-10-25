import { join } from "node:path";
import { Effect } from "effect";
import { download as downloadEffect } from "../../lib/typescript/http.ts";
import {
  execute as executeEffect,
  run as runEffect,
} from "../../lib/typescript/process.ts";

export const root = join(import.meta.dir, "../..");

export async function execute(command: string[], cwd = root, env = process.env) {
  return Effect.runPromise(executeEffect(command, { cwd, env }));
}

export async function run(command: string[], cwd = root, env = process.env) {
  return (await Effect.runPromise(runEffect(command, { cwd, env }))).trim();
}

export function download(url: string) {
  return Effect.runPromise(downloadEffect(url));
}
