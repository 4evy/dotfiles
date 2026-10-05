import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Connections } from "../connections/state";
import { manageHelper } from "../helper/manage";
import type { RemoteJobs } from "../jobs";
import { createHelperParameters } from "./schemas/helper";

export function registerHelperTool(
  api: ExtensionAPI,
  connections: Connections,
  jobs: RemoteJobs,
) {
  const { parameters } = createHelperParameters(api);
  api.registerTool({
    name: "remote_helper",
    label: "Remote helper installation",
    description:
      "Inspect, plan, install, upgrade or remove the helper over SSH using Linux native packages, existing Nix, or jobs-only Homebrew on macOS. Linux native changes require sudo; package artifacts require SHA-256. No package-manager setup or immutable-image changes.",
    parameters,
    loadMode: "discoverable",
    approval: (input) => {
      const parsed = parameters.safeParse(input);
      return parsed.success &&
        (parsed.data.action === "inspect" || parsed.data.action === "plan")
        ? "read"
        : "exec";
    },
    async execute(_id, input, signal, onUpdate, ctx) {
      const args = parameters.parse(input);
      return manageHelper(args, connections, jobs, ctx, signal, onUpdate);
    },
  });
}
