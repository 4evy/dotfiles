import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Redirect TypeScript CLI entrypoints without changing project dependencies
// Native binaries executed directly and TypeScript API imports are unaffected
// Resolve before matching so renamed symlinks cannot bypass the default
let resolved = "";
if (process.argv[1]) {
  try {
    resolved = realpathSync(process.argv[1]).replaceAll("\\", "/");
  } catch {
    // Let the runtime report missing entrypoints, stdin, and eval errors
  }
}
if (
  /\/(?:typescript|@typescript\/native-preview)\/(?:bin\/(?:tsc|tsgo)|lib\/(?:_?tsc|tsgo)\.js)$/.test(
    resolved,
  )
) {
  const result = spawnSync(join(homedir(), ".local/bin/tsrs"), process.argv.slice(2), {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exit(result.status ?? 1);
}
