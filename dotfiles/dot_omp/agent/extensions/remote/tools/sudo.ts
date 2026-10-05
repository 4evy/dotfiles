import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createShellRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import type { Connections } from "../connections/state";
import type { RemoteJobs } from "../jobs";
import { createSudoParameters } from "./schemas/sudo";
import { type ShellArgs, shellArguments } from "./shell";

export function registerSudoTool(
  api: ExtensionAPI,
  { selected }: Connections,
  jobs: RemoteJobs,
) {
  const { sudoParameters } = createSudoParameters(api);
  api.registerTool({
    name: "remote_sudo",
    label: "Remote sudo",
    description: "Run a remote sudo command with separate stdin-only authentication.",
    parameters: sudoParameters,
    loadMode: "discoverable",
    approval: "exec",
    ...createShellRenderer<ShellArgs>({
      ...shellArguments,
      resolveTitle: (args) => `Remote sudo · ${args?.connection || "SSH"}`,
    }),
    async execute(_id, input, signal, onUpdate, ctx) {
      const args = sudoParameters.parse(input);
      return jobs.sudo(selected(args.connection), args, ctx, signal, onUpdate);
    },
  });
}
