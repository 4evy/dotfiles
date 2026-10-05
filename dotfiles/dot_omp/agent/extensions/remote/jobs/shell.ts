import { quotePosixPath } from "@oh-my-pi/pi-coding-agent/ssh/utils";
import { z } from "zod";
import { resolveRemoteCwd } from "../connections/target";
import type { Connection } from "../connections/types";
import type { RunInput } from "./types";

const environment = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    z
      .string()
      .max(32768)
      .refine((value) => !value.includes("\0")),
  )
  .refine((env) => Object.keys(env).length <= 64);

export function commandShell(connection: Connection, input: RunInput) {
  const shell = input.shell ?? "bash";
  if (shell !== "bash" && shell !== "zsh") throw new Error("shell must be bash or zsh");
  const application = shell === "bash" ? connection.bash : connection.zsh;
  if (!application)
    throw new Error(`Remote ${shell} is unavailable; reconnect to refresh shell facts`);
  const env = environment.parse(input.env ?? {});
  const setup: string[] = [];
  if (input.envFiles?.length) {
    if (input.envFiles.length > 16) throw new Error("At most 16 envFiles are allowed");
    setup.push("set -a");
    for (const file of input.envFiles) {
      const path = quotePosixPath(resolveRemoteCwd(connection, file));
      setup.push(`. ${path} || exit $?`);
    }
    setup.push("set +a");
  }
  for (const [key, value] of Object.entries(env))
    setup.push(`export ${key}=${quotePosixPath(value)} || exit $?`);
  const command = [...setup, input.command].join("\n");
  const flags =
    shell === "bash"
      ? input.login
        ? ["--login"]
        : ["--noprofile", "--norc"]
      : input.login
        ? ["-l"]
        : ["-f"];
  return { application, args: [...flags, "-c", command] };
}
