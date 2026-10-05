import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createShellRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import type { Connections } from "../connections/state";
import type { RemoteJobs } from "../jobs";
import { JOB_ACTIONS } from "../jobs/types";
import { createJobParameters } from "./schemas/jobs";
import { type ShellArgs, shellArguments } from "./shell";

export function registerJobTools(
  api: ExtensionAPI,
  { selected }: Connections,
  jobs: RemoteJobs,
) {
  const { runParameters, jobParameters } = createJobParameters(api);
  api.registerTool({
    name: "remote_run",
    label: "Remote command",
    description:
      "Run a remote Bash or Zsh command with custom environment setup on the installed target broker with output, readiness and acknowledged completion delivery.",
    parameters: runParameters,
    loadMode: "discoverable",
    approval: "exec",
    ...createShellRenderer<ShellArgs>({
      ...shellArguments,
      resolveTitle: (args) => `Remote · ${args?.connection || "SSH"}`,
    }),
    async execute(_id, input, signal, onUpdate, ctx) {
      const args = runParameters.parse(input);
      return jobs.run(selected(args.connection), args, ctx, signal, onUpdate);
    },
  });
  api.registerTool({
    name: "remote_job",
    label: "Remote job",
    description:
      "Inspect jobs, answer prompts, enter plaintext passwords, send keys, read or resize TUI screens, interrupt, stop or change lifetime.",
    parameters: jobParameters,
    loadMode: "discoverable",
    approval: (input) => {
      const parsed = jobParameters.safeParse(input);
      return parsed.success ? JOB_ACTIONS[parsed.data.action].approval : "exec";
    },
    async execute(_id, input, signal, _update, ctx) {
      return jobs.control(jobParameters.parse(input), ctx, signal);
    },
  });
}
