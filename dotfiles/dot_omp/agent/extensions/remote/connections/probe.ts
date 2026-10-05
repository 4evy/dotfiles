import { randomUUID } from "node:crypto";
import type {
  SSHConnectionTarget,
  SSHHostInfo,
} from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { quotePosixPath } from "@oh-my-pi/pi-coding-agent/ssh/utils";
import { ptree } from "@oh-my-pi/pi-utils";
import { argv } from "./command";
import { pathValue } from "./target";

const PROBE_ERRORS: Readonly<Record<number, string>> = {
  72: "Remote cwd does not exist or cannot be entered",
  73: "Remote Bash executable is unavailable",
  255: "SSH probe did not complete; remote state is unknown",
};

export async function probeConnection(
  target: SSHConnectionTarget,
  info: SSHHostInfo,
  requested: string | undefined,
  cwd: string,
  controlPath: string,
  signal?: AbortSignal,
) {
  if (requested !== undefined) pathValue(requested, "Remote cwd");
  if (requested?.startsWith("~") && requested !== "~" && !requested.startsWith("~/")) {
    throw new Error("Remote cwd supports '~/' but not another user's '~name' home");
  }
  const destinationCwd =
    requested === undefined || requested === "~"
      ? '"$home"'
      : requested.startsWith("~/")
        ? `"$home"/${quotePosixPath(requested.slice(2))}`
        : requested.startsWith("/")
          ? quotePosixPath(requested)
          : `"$home"/${quotePosixPath(requested)}`;
  const marker = `OMP_REMOTE_PROBE_${randomUUID().replaceAll("-", "")}`;
  const script = [
    "home=$HOME",
    'case "$home" in /*) ;; *) printf "%s\\n" "Remote HOME is missing or not absolute" >&2; exit 71 ;; esac',
    `cd -- ${destinationCwd} || exit 72`,
    `directory=$(pwd -P; printf x); directory=\${directory%x}; directory=\${directory%?}`,
    "bash=$(command -v bash) || exit 73",
    'case "$bash" in /*) ;; *) exit 73 ;; esac',
    '[ -x "$bash" ] || exit 73',
    `"$bash" -c 'test -n "$BASH_VERSION"' || exit 73`,
    "zsh=$(command -v zsh 2>/dev/null) || zsh=",
    'case "$zsh" in /*) [ -x "$zsh" ] && "$zsh" -f -c \'test -n "$ZSH_VERSION"\' || zsh= ;; *) zsh= ;; esac',
    "deadline=$(command -v timeout 2>/dev/null) || deadline=",
    'case "$deadline" in /*) if [ -x "$deadline" ]; then version=$("$deadline" --version 2>/dev/null); case "$version" in *"GNU coreutils"*) ;; *) deadline= ;; esac; else deadline=; fi ;; *) deadline= ;; esac',
    "arch=$(uname -m) || exit 74",
    `printf '\\0${marker}\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0${
      marker
    }\\0' "$home" "$directory" "$bash" "$deadline" "$arch" "$zsh"`,
  ].join("\n");
  const args = await argv(target, info, script, false, controlPath);
  signal?.throwIfAborted();
  const result = await ptree.exec(["ssh", ...args], {
    cwd,
    timeout: 30_000,
    ...(signal ? { signal } : {}),
    allowNonZero: true,
    allowAbort: true,
  });
  signal?.throwIfAborted();
  if (!result.ok || result.exitCode !== 0) {
    const reason =
      result.exitCode === null
        ? "SSH probe did not complete; remote state is unknown"
        : (PROBE_ERRORS[result.exitCode] ??
          `Remote connection probe failed (SSH exit ${result.exitCode})`);
    throw new Error(`${reason}${result.stderr ? `: ${result.stderr.trimEnd()}` : ""}`);
  }
  const frame = `\0${marker}\0`;
  const start = result.stdout.indexOf(frame);
  const end = result.stdout.indexOf(frame, start + frame.length);
  if (start < 0 || end < 0)
    throw new Error(
      "SSH probe returned no complete remote facts frame; remote state is unknown",
    );
  const fields = result.stdout.slice(start + frame.length, end).split("\0");
  const [home, directory, bash, timeout, arch, zsh] = fields;
  if (
    fields.length !== 6 ||
    !home?.startsWith("/") ||
    !directory?.startsWith("/") ||
    !bash?.startsWith("/") ||
    (zsh && !zsh.startsWith("/")) ||
    (timeout && !timeout.startsWith("/")) ||
    !arch ||
    /[\s\p{Cc}]/u.test(arch)
  ) {
    throw new Error("SSH probe returned invalid remote facts");
  }
  return {
    home,
    cwd: directory,
    bash,
    ...(zsh ? { zsh } : {}),
    ...(timeout ? { timeout } : {}),
    arch,
  };
}
