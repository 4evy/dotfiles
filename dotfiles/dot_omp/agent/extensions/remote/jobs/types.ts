import type {
  AgentToolResult,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { BashToolDetails } from "@oh-my-pi/pi-tui/tools/bash";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type { z } from "zod";
import type {
  JobLogs,
  JobReceipt,
  TerminationResult,
  TerminationStatus,
} from "../../../lib/helper/jobs";
import type { deliverySchema, jobSchema, launchSchema } from "./records";

export interface RunInput {
  command: string;
  name?: string | undefined;
  cwd?: string | undefined;
  timeout?: number | undefined;
  waitSeconds?: number | undefined;
  pty?: boolean | undefined;
  columns?: number | undefined;
  rows?: number | undefined;
  ready?: string | undefined;
  lifetime?: "session" | "persist" | undefined;
  env?: Record<string, string> | undefined;
  shell?: "bash" | "zsh" | undefined;
  login?: boolean | undefined;
  envFiles?: string[] | undefined;
  raw?: boolean | undefined;
  compact?: boolean | undefined;
}

export const MAX_SEQUENCE_STEPS = 20;

export const JOB_ACTIONS = {
  list: { approval: "read", waitSeconds: 0 },
  status: { approval: "read", waitSeconds: 0 },
  logs: { approval: "read", waitSeconds: 0 },
  wait: { approval: "read", waitSeconds: 30 },
  receipt: { approval: "read", waitSeconds: 0 },
  sequence: { approval: "exec", waitSeconds: 0.2 },
  input: { approval: "exec", waitSeconds: 0.2, notice: "Sent raw input" },
  reply: { approval: "exec", waitSeconds: 0.2, notice: "Submitted reply" },
  password: { approval: "exec", waitSeconds: 0.2, notice: "Submitted password" },
  keys: { approval: "exec", waitSeconds: 0.2, notice: "Sent key sequence" },
  screen: { approval: "read", waitSeconds: 0 },
  resize: { approval: "exec", waitSeconds: 0.2 },
  interrupt: { approval: "exec", waitSeconds: 0, notice: "Sent Ctrl-C" },
  stop: { approval: "exec", waitSeconds: 0 },
  force: { approval: "exec", waitSeconds: 0 },
  mode: { approval: "exec", waitSeconds: 0 },
} as const;

export interface JobInput {
  action: keyof typeof JOB_ACTIONS;
  job?: string | undefined;
  data?: string | undefined;
  keys?: string[] | undefined;
  prompt?: string | undefined;
  columns?: number | undefined;
  rows?: number | undefined;
  cursor?: number | undefined;
  lines?: number | undefined;
  waitSeconds?: number | undefined;
  pattern?: string | undefined;
  lifetime?: "session" | "persist" | undefined;
  actionId?: string | undefined;
  expectedScreenVersion?: string | undefined;
  settleMs?: number | undefined;
  maxWaitMs?: number | undefined;
  raw?: boolean | undefined;
  compact?: boolean | undefined;
  steps?:
    | Array<{
        keys: string[];
        expect?: string | undefined;
        screenVersion?: string | undefined;
      }>
    | undefined;
}

export interface RemoteJobDetails extends BashToolDetails {
  job?: string | undefined;
  connectionId?: string | undefined;
  cwd?: string | undefined;
  remoteExitCode?: number | undefined;
  remoteState?: "running" | "completed" | "unknown" | undefined;
  state?: DaemonSnapshot["state"] | undefined;
  lifetime?: "session" | "persist" | undefined;
  cursor?: number | undefined;
  waitTimedOut?: boolean | undefined;
  matched?: string | undefined;
  completionId?: string | undefined;
  owner?: string | undefined;
  nativeId?: string | undefined;
  installationId?: string | undefined;
  scopeId?: string | undefined;
  terminalRows?: string[] | undefined;
  terminalColumns?: number | undefined;
  terminalHeight?: number | undefined;
  terminalStyleRows?: string[] | undefined;
  screenVersion?: string | undefined;
  settled?: boolean | undefined;
  receipt?: Omit<JobReceipt, "daemon" | "logs"> | undefined;
  sequence?:
    | {
        actionId: string;
        receipts: Array<Omit<JobReceipt, "daemon" | "logs">>;
        completedSteps: number;
        error?: string | undefined;
      }
    | undefined;
  newOutput?: string | undefined;
  rawOutput?: string | undefined;
  unreadCursor?: number | undefined;
  replay?: boolean | undefined;
  compact?: boolean | undefined;
  interpreter?: string | undefined;
  finishedAt?: number | undefined;
  deliveredAt?: number | undefined;
  deliveryDelayMs?: number | undefined;
  observedAt?: number | undefined;
  termination?: TerminationResult["termination"] | undefined;
  deadline?: TerminationStatus["deadline"] | undefined;
}

export type LaunchRecord = Readonly<z.infer<typeof launchSchema>>;

export type JobRecord = Readonly<z.infer<typeof jobSchema>>;

export type DeliveryRecord = z.infer<typeof deliverySchema>;

interface Foreground {
  count: number;
  done: Promise<void>;
  resolve(): void;
}

export interface Scope {
  ctx: ExtensionContext;
  owner: string;
  projectDir: string;
  scopeId: string;
  branch: Map<string, LaunchRecord>;
  all: Map<string, LaunchRecord>;
  deliveries: Map<string, DeliveryRecord>;
  foreground: Map<string, Foreground>;
}

export type Logs = JobLogs & {
  rawText?: string | undefined;
  replay?: boolean | undefined;
  outputGap?: string | undefined;
  terminationStatus?: TerminationStatus | undefined;
};
export interface JobView {
  daemon: DaemonSnapshot;
  logs: Logs;
}
export type Result = AgentToolResult<RemoteJobDetails>;
