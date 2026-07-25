import { existsSync } from "node:fs";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  type ExtensionAPI,
  formatSize,
  type TruncationResult,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 1800;
const SYSTEM_RUNNER = `${process.env.HOME ?? ""}/.local/bin/system-runner`;

const systemRunSchema = Type.Object({
  command: Type.String({
    description: "Shell command to execute through sudo -n system-runner.",
  }),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the command. Defaults to pi's current working directory.",
    }),
  ),
  timeout_sec: Type.Optional(
    Type.Number({
      description: "Timeout in seconds. Defaults to 300; maximum is 1800.",
      maximum: MAX_TIMEOUT_SEC,
      minimum: 1,
    }),
  ),
});

type SystemRunDetails = {
  exit_status: string;
  stderr: string;
  stderr_truncated: boolean;
  stderr_truncation?: TruncationResult;
  stdout: string;
  stdout_truncated: boolean;
  stdout_truncation?: TruncationResult;
  success: boolean;
  timed_out: boolean;
};

function formatOutput(name: "stdout" | "stderr", output: TruncationResult): string[] {
  if (!output.content && !output.truncated) return [];

  const truncationNotice = output.truncated
    ? ` (last ${output.outputLines} of ${output.totalLines} lines, ${formatSize(output.outputBytes)} of ${formatSize(output.totalBytes)})`
    : "";
  return [`${name}${truncationNotice}:\n${output.content}`];
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "system_run",
      label: "System Run",
      description:
        "Run a local shell command through `sudo -n system-runner`. Command exit failures are returned as success=false with stdout/stderr, not as tool errors. Output keeps the last 2,000 lines or 50KB per stream.",
      promptSnippet:
        "Run local shell commands through sudo -n system-runner when elevated/system runner execution is needed",
      promptGuidelines: [
        "Use system_run only when the normal bash tool cannot perform the requested system-level command or when the user explicitly asks for system-runner/free execution.",
        "Treat system_run as destructive-capable: avoid changing system state unless the user asked for it.",
      ],
      parameters: systemRunSchema,

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (params.command.trim().length === 0)
          throw new Error("command must not be empty");

        const timeoutSec = params.timeout_sec ?? DEFAULT_TIMEOUT_SEC;
        if (
          !Number.isFinite(timeoutSec) ||
          timeoutSec <= 0 ||
          timeoutSec > MAX_TIMEOUT_SEC
        ) {
          throw new Error(`timeout_sec must be between 1 and ${MAX_TIMEOUT_SEC}`);
        }

        const result = await pi.exec(
          "sudo",
          [
            "-n",
            existsSync(SYSTEM_RUNNER) ? SYSTEM_RUNNER : "system-runner",
            ...(process.env.PATH ? ["--env", `PATH=${process.env.PATH}`] : []),
            "--",
            "/bin/sh",
            "-c",
            params.command,
          ],
          {
            cwd: params.cwd?.trim() || ctx.cwd,
            ...(signal ? { signal } : {}),
            timeout: timeoutSec * 1000,
          },
        );
        const truncationOptions = {
          maxBytes: DEFAULT_MAX_BYTES,
          maxLines: DEFAULT_MAX_LINES,
        };
        const stdout = truncateTail(result.stdout, truncationOptions);
        const stderr = truncateTail(result.stderr, truncationOptions);
        const details = {
          exit_status: signal?.aborted
            ? "cancelled"
            : result.killed
              ? `timed out after ${timeoutSec} seconds`
              : String(result.code),
          stderr: stderr.content,
          stderr_truncated: stderr.truncated,
          ...(stderr.truncated ? { stderr_truncation: stderr } : {}),
          stdout: stdout.content,
          stdout_truncated: stdout.truncated,
          ...(stdout.truncated ? { stdout_truncation: stdout } : {}),
          success: !result.killed && result.code === 0,
          timed_out: result.killed && !signal?.aborted,
        } satisfies SystemRunDetails;

        return {
          content: [
            {
              type: "text",
              text: [
                `exit_status: ${details.exit_status}`,
                `success: ${details.success}`,
                `timed_out: ${details.timed_out}`,
                ...formatOutput("stdout", stdout),
                ...formatOutput("stderr", stderr),
              ].join("\n"),
            },
          ],
          details,
        };
      },
    }),
  );
}
