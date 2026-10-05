import { quotePosixPath } from "@oh-my-pi/pi-coding-agent/ssh/utils";
import { resolveRemoteCwd } from "../connections/target";
import type { Connection } from "../connections/types";

export interface SudoInput {
  command: string;
  cwd?: string | undefined;
  timeout?: number | undefined;
  password?: string | undefined;
}

export const AUTH_SECONDS = 15;

// Job control gives the watchdog a separate group, so its sleep is also reaped
// The privileged watchdog runs as root and can terminate its command group
function boundedShell(marker: string, announceTimeout: boolean): string {
  return `bounded() {
  local seconds=$1 command_pid watchdog_pid command_status budget_expired=0
  shift
  trap 'budget_expired=1' USR1
  set -m
  "$@" <&0 &
  command_pid=$!
  (
    sleep "$seconds"
    kill -USR1 "$$"
    ${announceTimeout ? `printf '%s' ${quotePosixPath(`${marker}timeout\x1f`)}` : ":"}
    kill -TERM -- "-$command_pid" 2>/dev/null
    sleep 2
    kill -KILL -- "-$command_pid" 2>/dev/null
  ) </dev/null ${announceTimeout ? "2>/dev/null" : ">/dev/null 2>&1"} &
  watchdog_pid=$!
  set +m
  wait "$command_pid" 2>/dev/null
  command_status=$?
  if [ "$budget_expired" -ne 0 ]; then
    wait "$command_pid" 2>/dev/null
    wait "$watchdog_pid" 2>/dev/null
    command_status=124
  else
    kill -TERM -- "-$watchdog_pid" 2>/dev/null
    wait "$watchdog_pid" 2>/dev/null
  fi
  trap - USR1
  return "$command_status"
}`;
}

export function sudoShell(
  connection: Connection,
  input: SudoInput,
  seconds: number,
  marker: string,
): string {
  const cwd = resolveRemoteCwd(connection, input.cwd);
  const command = `cd -- ${quotePosixPath(cwd)} || exit\n${input.command}`;
  const privileged = `set +x
set +v
unset BASH_ENV ENV
${boundedShell(marker, true)}
bounded ${seconds} ${quotePosixPath(connection.bash)} --noprofile --norc -c ${quotePosixPath(
    command,
  )} </dev/null
exit $?`;
  const script = `set +x
set +v
exec 2>&1
unset BASH_ENV ENV
unset sudo_password
${boundedShell(marker, false)}
auth_status=1
if [ -r /etc/bleh ]; then
  bounded ${AUTH_SECONDS} sudo -S -p '' -v </etc/bleh >/dev/null 2>&1
  auth_status=$?
fi
if [ "$auth_status" -ne 0 ]; then
  bounded ${AUTH_SECONDS} sudo -n -v </dev/null >/dev/null 2>&1
  auth_status=$?
fi
if [ "$auth_status" -ne 0 ]; then
  printf '%s' ${quotePosixPath(`${marker}credentials\x1f`)}
  if ! IFS= read -r -t 120 sudo_password; then
    printf '%s' ${quotePosixPath(`${marker}required\x1f`)}
    exit 1
  fi
  bounded ${AUTH_SECONDS} sudo -S -p '' -v <<< "$sudo_password" >/dev/null 2>&1
  auth_status=$?
  unset sudo_password
  if [ "$auth_status" -ne 0 ]; then
    printf '%s' ${quotePosixPath(`${marker}rejected\x1f`)}
    exit 1
  fi
fi
printf '%s' ${quotePosixPath(`${marker}started\x1f`)}
sudo -n -- ${quotePosixPath(connection.bash)} --noprofile --norc -c ${quotePosixPath(
    privileged,
  )} </dev/null
command_status=$?
printf '%s%s%s' ${quotePosixPath(`${marker}done:`)} "$command_status" ${quotePosixPath(
    "\x1f",
  )}
exit "$command_status"`;
  return `set +x; set +v; unset BASH_ENV ENV; exec ${quotePosixPath(
    connection.bash,
  )} --noprofile --norc -c ${quotePosixPath(script)}`;
}
