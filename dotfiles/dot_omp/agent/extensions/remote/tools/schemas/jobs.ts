import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TERMINAL_KEYS } from "../../jobs/terminal";
import { JOB_ACTIONS, MAX_SEQUENCE_STEPS } from "../../jobs/types";
import { commandFields } from "../shell";

export function createJobParameters(api: ExtensionAPI) {
  const z = api.zod;
  const columnsParameter = z.number().int().min(20).max(400).optional();
  const rowsParameter = z.number().int().min(5).max(200).optional();
  const lifetimeParameter = z.enum(["session", "persist"]).optional();
  const runParameters = z.object({
    ...commandFields(api),
    name: z.string().optional().describe("Readable suffix; handle remains unique"),
    cwd: z.string().optional().describe("Remote absolute or connection-relative cwd"),
    timeout: z
      .number()
      .int()
      .min(0)
      .max(3600)
      .optional()
      .describe("Remote seconds; 0 disables deadline"),
    waitSeconds: z
      .number()
      .min(0)
      .max(30)
      .optional()
      .describe("Initial observation budget, not command deadline"),
    pty: z.boolean().optional().describe("Target broker PTY; default true"),
    columns: columnsParameter.describe("PTY columns; default 120"),
    rows: rowsParameter.describe("PTY rows; default 40"),
    ready: z.string().min(1).optional().describe("Readiness regex in remote output"),
    lifetime: lifetimeParameter,
    shell: z
      .enum(["bash", "zsh"])
      .optional()
      .describe("Remote interpreter; default bash"),
    login: z
      .boolean()
      .optional()
      .describe("Load the selected shell's login startup files; default false"),
    envFiles: z
      .array(z.string().min(1))
      .max(16)
      .optional()
      .describe(
        "Remote shell files to source with auto-export before the command; paths relative to connection cwd",
      ),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Custom variables exported after startup and envFiles; valid shell identifiers, up to 64 NUL-free values of 32768 characters. Values are stored in job launch arguments; load secrets from remote envFiles instead",
      ),
    raw: z.boolean().optional().describe("Include unread raw terminal redraw logs"),
    compact: z.boolean().optional().describe("Compact structured result; default true"),
  });
  const jobParameters = z.object({
    action: z.enum(
      Object.keys(JOB_ACTIONS) as [
        keyof typeof JOB_ACTIONS,
        ...Array<keyof typeof JOB_ACTIONS>,
      ],
    ),
    job: z.string().optional().describe("Exact returned job handle"),
    data: z
      .string()
      .optional()
      .describe("Raw input, or a reply/password submitted with Enter"),
    keys: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(`Named terminal keys in order. ${TERMINAL_KEYS}`),
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe("Label for a plaintext password prompt"),
    columns: columnsParameter.describe("New PTY width for resize"),
    rows: rowsParameter.describe("New PTY height for resize"),
    cursor: z.number().int().min(0).optional(),
    lines: z.number().int().min(1).max(1000).optional(),
    waitSeconds: z.number().min(0).max(60).optional(),
    pattern: z.string().optional().describe("Output regex for wait"),
    lifetime: lifetimeParameter,
    actionId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/u)
      .optional()
      .describe("Stable input ID; duplicate IDs recover receipts without resending"),
    expectedScreenVersion: z
      .string()
      .min(1)
      .optional()
      .describe("Reject input if the observed screen changed"),
    settleMs: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .optional()
      .describe("Quiet terminal window in milliseconds; default 100"),
    maxWaitMs: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .optional()
      .describe("Hard terminal settling budget; default 500, even for spinners"),
    raw: z.boolean().optional().describe("Include unread raw terminal redraw logs"),
    compact: z.boolean().optional().describe("Compact structured result; default true"),
    steps: z
      .array(
        z.object({
          keys: z.array(z.string().min(1)).min(1).max(64),
          expect: z
            .string()
            .min(1)
            .describe("Regex required in the screen after this step"),
          screenVersion: z.string().min(1).optional(),
        }),
      )
      .min(1)
      .max(MAX_SEQUENCE_STEPS)
      .optional()
      .describe("Bounded checked sequence; stop before the next step on mismatch"),
  });
  return { runParameters, jobParameters };
}
