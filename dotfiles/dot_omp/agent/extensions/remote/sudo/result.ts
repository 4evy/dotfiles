import type { BashToolDetails } from "@oh-my-pi/pi-tui/tools/bash";

export function sudoState() {
  return {
    commandStarted: false,
    authRequired: false,
    authRejected: false,
    promptCancelled: false,
    invalidPrompt: false,
    timedOut: false,
    localDeadline: false,
    outputLost: false,
    stopConfirmed: false,
    exitCode: undefined as number | undefined,
  };
}

export function sudoStatus(
  state: ReturnType<typeof sudoState>,
  details: BashToolDetails,
  seconds: number,
  aborted: boolean,
): { status: string; failed: boolean } {
  let status: string;
  let failed = true;
  if (state.exitCode !== undefined) {
    details.exitCode = state.exitCode;
    if (state.timedOut || state.localDeadline) details.timedOut = true;
    failed = state.exitCode !== 0 || state.timedOut || state.localDeadline;
    status = state.timedOut
      ? `Sudo exceeded its ${seconds}-second command budget and exited with code ${state.exitCode}`
      : `Sudo invocation exited with code ${state.exitCode}${state.localDeadline ? "; the observation budget also elapsed" : ""}`;
  } else if (state.authRejected)
    status =
      "Sudo authentication failed or exceeded its bounded budget; no command was run. Provide a valid sudo password or grant sudo access";
  else if (state.invalidPrompt)
    status = "Sudo passwords must be single-line values without NUL characters";
  else if (state.promptCancelled)
    status = `Sudo password entry was cancelled or expired; ${state.stopConfirmed ? "the waiting job was stopped" : "the identity-checked stop was attempted but its outcome is unknown"}`;
  else if (state.authRequired)
    status = `Sudo authentication requires a password. ${state.stopConfirmed ? "The waiting job was stopped" : "The identity-checked stop was attempted but its outcome is unknown"}; supply password or use an interactive session`;
  else if (state.timedOut || state.localDeadline) {
    details.timedOut = true;
    status = state.commandStarted
      ? `Sudo exceeded its ${seconds}-second command budget; the final command exit is unknown`
      : "Sudo authentication or credential entry exceeded its bounded budget; no command execution was observed";
  } else if (aborted)
    status = state.commandStarted
      ? "Sudo was cancelled; the remote command's final exit is unknown"
      : "Sudo was cancelled before command execution was observed";
  else
    status = state.commandStarted
      ? "The remote sudo channel ended without a command exit status; the command outcome is unknown and the root-side watchdog remains bounded"
      : "The remote sudo channel ended before command execution was observed; the outcome is unknown";
  if (state.outputLost) status += "; raw output continuity was lost to log rotation";
  return { status, failed };
}
