import {
  type DaemonRpcResult,
  parseDaemonRpcResult,
  parseDaemonSnapshot,
  parseDaemonSpec,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { z } from "zod";

export const JOB_CAPABILITIES = [
  "jobs",
  "terminal-size",
  "terminal-replay",
  "completion-ack",
  "raw-output",
  "job-actions",
  "settled-screen",
  "styled-screen",
  "job-environment",
  "job-termination",
  "job-deadlines",
] as const;
export const JOB_COMPLETION_METHOD = "notifications/omp-helper/job-completion";

const stylesSchema = z.object({ terminalStyleRows: z.array(z.string()).optional() });

const boundedString = z
  .string()
  .max(32768)
  .refine((value) => !value.includes("\0"));
export const jobEnvironmentKey =
  /^(?:TERM|COLORTERM|LANG|LANGUAGE|LC_[A-Z_]+|TZ|PATH|TMPDIR|XDG_(?:CONFIG_HOME|DATA_HOME|STATE_HOME|CACHE_HOME|CONFIG_DIRS|DATA_DIRS))$/u;
export const jobEnvironmentSchema = z
  .record(z.string().regex(jobEnvironmentKey), boundedString)
  .refine(
    (env) => Object.keys(env).length <= 64,
    "At most 64 environment overrides are allowed",
  );
export const jobIdentitySchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => !value.includes("\0")),
  nativeId: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => !value.includes("\0")),
});
export const actionIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
export const settlingShape = {
  settleMs: z.number().int().min(0).max(1000).default(100),
  maxWaitMs: z.number().int().min(0).max(5000).default(500),
};
export const observeRequestSchema = jobIdentitySchema.extend(settlingShape);
export const actionRequestSchema = jobIdentitySchema
  .extend({
    actionId: actionIdSchema,
    data: z.string().max(262144).optional(),
    resize: z
      .strictObject({
        columns: z.number().int().min(20).max(400),
        rows: z.number().int().min(5).max(200),
      })
      .optional(),
    expectedScreenVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    ...settlingShape,
  })
  .refine(
    (value) => value.data !== undefined || value.resize !== undefined,
    "Action requires data or resize",
  );
export const receiptRequestSchema = jobIdentitySchema.extend({
  actionId: actionIdSchema,
});
const daemonSchema = z.unknown().transform((value) => parseDaemonSnapshot(value));
export type JobLogs = Extract<DaemonRpcResult, { op: "logs" }> & {
  terminalStyleRows?: string[] | undefined;
};
const logsSchema = z.unknown().transform((value): JobLogs => {
  const parsed = parseDaemonRpcResult(
    {
      op: "logs",
      name: "screen",
      lines: 1000,
      head: false,
      follow: false,
      timeoutMs: 0,
    },
    value,
  );
  if (parsed.op !== "logs") throw new Error("Expected terminal logs");
  const styles = stylesSchema.parse(value);
  return { ...parsed, ...styles };
});
export const observeResultSchema = z.strictObject({
  daemon: daemonSchema,
  logs: logsSchema,
  screenVersion: z.string().regex(/^[a-f0-9]{64}$/u),
  settled: z.boolean(),
  observedAt: z.number().int().nonnegative(),
});
export const actionReceiptSchema = jobIdentitySchema.extend({
  actionId: actionIdSchema,
  state: z
    .enum(["not-sent", "sent-outcome-unknown", "processed"])
    .describe(
      "Processed means broker accepted plus terminal observed, not proof the application consumed input",
    ),
  createdAt: z.number().int().nonnegative(),
  sentAt: z.number().int().nonnegative().optional(),
  observedAt: z.number().int().nonnegative().optional(),
  screenVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  settled: z.boolean().optional(),
  daemon: daemonSchema.optional(),
  logs: logsSchema.optional(),
  error: z.string().optional(),
});
export const terminationRequestSchema = jobIdentitySchema.extend({
  actionId: actionIdSchema,
  kind: z.enum(["interrupt", "stop", "force"]),
  timeoutMs: z.number().int().min(0).max(10000).default(2000),
});
export const terminationMetadataSchema = z.strictObject({
  kind: z.enum(["interrupt", "stop", "force"]),
  requestedAt: z.number().int().nonnegative(),
  brokerAccepted: z.boolean(),
  leaderExited: z.boolean(),
  childrenGone: z.literal("unknown"),
  trackedProcessesNoLongerObserved: z.boolean().optional(),
});
export const terminationResultSchema = z.strictObject({
  receipt: actionReceiptSchema,
  termination: terminationMetadataSchema,
});
export const prepareStartRequestSchema = z.strictObject({
  operation: z.unknown(),
  deadlineSeconds: z.number().int().min(0).max(2147483).default(0),
});
export const prepareStartResultSchema = z.strictObject({
  spec: z.unknown().transform((value) => parseDaemonSpec(value)),
});
export const deadlineEvidenceSchema = z.strictObject({
  deadlineSeconds: z.number().int().positive(),
  preparedAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  deadlineTriggeredAt: z.number().int().nonnegative().optional(),
  signalSentAt: z.number().int().nonnegative().optional(),
  forceSentAt: z.number().int().nonnegative().optional(),
  leaderExited: z.boolean().optional(),
  trackedProcessesNoLongerObserved: z.boolean().optional(),
  childrenGone: z.literal("unknown"),
  exitCode: z.number().int().optional(),
  nativeTreeSignalFailed: z.boolean().optional(),
  error: z.literal("deadline-enforcement-failed").optional(),
});
export const terminationStatusSchema = z.strictObject({
  termination: terminationMetadataSchema.optional(),
  deadline: deadlineEvidenceSchema.optional(),
});
export type PrepareStartRequest = z.input<typeof prepareStartRequestSchema>;
export type TerminationStatus = z.infer<typeof terminationStatusSchema>;
export type JobObservation = z.infer<typeof observeResultSchema>;
export type ActionReceipt = z.infer<typeof actionReceiptSchema>;
export type JobReceipt = ActionReceipt;
export type ActionRequest = z.input<typeof actionRequestSchema>;
export type TerminationRequest = z.input<typeof terminationRequestSchema>;
export type TerminationResult = z.infer<typeof terminationResultSchema>;
