import { dirname, join } from "node:path";
import { exec } from "@oh-my-pi/pi-utils/ptree";
import { paths } from "../state";
export async function command(
  argv: string[],
  allowFailure = false,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const runtime = dirname(paths().runtime);
  const {
    exitCode: code,
    stdout,
    stderr,
  } = await exec(argv, {
    allowNonZero: true,
    stderr: "full",
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: runtime,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtime, "bus")}`,
    },
  });
  if (code !== 0 && !allowFailure)
    throw new Error(`${argv[0]} ${argv[1] ?? ""} failed (${code}): ${stderr.trim()}`);
  return { code, stdout, stderr };
}
