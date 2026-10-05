import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Connections } from "../connections/state";
import type { DesktopOperations } from "../desktop";
import type { RemoteJobs } from "../jobs";
import { registerConnectionTool } from "./connection";
import { registerDesktopTools } from "./desktop";
import { registerFileTools } from "./files";
import { registerHelperTool } from "./helper";
import { registerJobTools } from "./jobs";
import { registerSudoTool } from "./sudo";

export function registerTools(
  api: ExtensionAPI,
  connections: Connections,
  jobs: RemoteJobs,
  desktop: DesktopOperations,
) {
  registerConnectionTool(api, connections);
  registerJobTools(api, connections, jobs);
  registerFileTools(api, connections);
  registerSudoTool(api, connections, jobs);
  registerDesktopTools(api, connections, desktop);
  registerHelperTool(api, connections, jobs);
}
