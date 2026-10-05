import { randomUUID } from "node:crypto";
import type {
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { remoteArgv } from "../connections/command";
import type { Connection } from "../connections/types";
import { AUTH_SECONDS, type SudoInput, sudoShell } from "../sudo/script";

/** Installation cannot use the job broker it is installing or quiescing */
export async function installWithSudo(
  connection: Connection,
  input: SudoInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
) {
  if (input.password !== undefined && /[\r\n\0]/u.test(input.password))
    throw new Error("Sudo passwords must be single-line values without NUL characters");
  const seconds = input.timeout ?? 600;
  const marker = `\x1eOMP_INSTALL_${randomUUID().replaceAll("-", "")}:`;
  const argv = await remoteArgv(
    connection,
    sudoShell(connection, input, seconds, marker),
    false,
  );
  signal?.throwIfAborted();
  const child = Bun.spawn(["ssh", ...argv], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = AbortSignal.timeout((seconds + 120 + AUTH_SECONDS * 3 + 10) * 1000);
  const cancellation = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
  const stop = () => child.kill();
  cancellation.addEventListener("abort", stop, { once: true });
  if (cancellation.aborted) stop();
  let pending = "";
  let output = "";
  let exitCode: number | undefined;
  let auth: string | undefined;
  let prompted = false;
  const emit = (text: string) => {
    output = (output + text).slice(-32_768);
    if (text) onUpdate?.({ content: [{ type: "text", text }], details: {} });
  };
  const control = async (record: string) => {
    if (record === "credentials") {
      if (prompted) throw new Error("Duplicate sudo credential request");
      prompted = true;
      const password =
        input.password ??
        (ctx.hasUI
          ? await ctx.ui.input(
              `Sudo password (${connection.id}; helper installation): `,
              undefined,
              { signal: cancellation },
            )
          : undefined);
      if (password !== undefined) {
        if (/[\r\n\0]/u.test(password))
          throw new Error(
            "Sudo passwords must be single-line values without NUL characters",
          );
        child.stdin.write(`${password}\n`);
        await child.stdin.flush();
      }
      child.stdin.end();
    } else if (/^done:\d+$/u.test(record)) exitCode = Number(record.slice(5));
    else if (["required", "rejected", "timeout"].includes(record)) auth = record;
  };
  const stderr = new Response(child.stderr).text();
  try {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      while (pending) {
        const start = pending.indexOf(marker);
        if (start < 0) {
          const safe = Math.max(0, pending.length - marker.length + 1);
          emit(pending.slice(0, safe));
          pending = pending.slice(safe);
          break;
        }
        emit(pending.slice(0, start));
        pending = pending.slice(start);
        const end = pending.indexOf("\x1f", marker.length);
        if (end < 0) break;
        const record = pending.slice(marker.length, end);
        pending = pending.slice(end + 1);
        await control(record);
      }
    }
    pending += decoder.decode();
    if (!pending.startsWith(marker)) emit(pending);
    const sshExitCode = await child.exited;
    const error = await stderr;
    return {
      isError: cancellation.aborted || sshExitCode !== 0 || exitCode !== 0,
      exitCode: exitCode ?? null,
      sshExitCode,
      authentication: auth ?? null,
      output,
      error,
      ...(cancellation.aborted
        ? {
            outcome:
              "SSH cancelled or timed out; the root watchdog bounds the transaction, but inspect package state before retrying",
          }
        : {}),
    };
  } finally {
    cancellation.removeEventListener("abort", stop);
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}
