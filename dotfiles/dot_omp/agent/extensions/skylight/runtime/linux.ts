import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULES } from "./paths";

export async function installLinuxService(
  env: Record<string, string>,
  directory: string,
) {
  const helper = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
    "omp-helper/current/bin/omp-helper",
  );
  try {
    await access(helper, constants.X_OK);
  } catch {
    throw new Error("Linux Skylight requires an approval-installed omp-helper package");
  }
  const servicePath = join(directory, "service.mjs");
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../linux/service.ts", import.meta.url))],
    target: "node",
    format: "esm",
  });
  const output = build.outputs[0];
  if (!build.success || build.outputs.length !== 1 || !output) {
    throw new Error(`Linux Sky service compilation failed: ${build.logs.join("\n")}`);
  }
  await Bun.write(servicePath, output);
  env.NODE_REPL_TRUSTED_CODE_PATHS = [MODULES, directory].join(delimiter);
  env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify({ sky: servicePath });
  env.OMP_SKY_HELPER_PATH = helper;
  env.OMP_SKY_SESSION_DIR = directory;
}
