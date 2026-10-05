import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createConnections } from "./connections/state";
import { createDesktop } from "./desktop";
import { registerGuide } from "./guide/guide";
import { RemoteJobs } from "./jobs";
import { registerTools } from "./tools";

export default function remote(api: ExtensionAPI) {
  const connections = createConnections(api);
  const jobs = new RemoteJobs(api, connections);
  const desktop = createDesktop();
  const restore = async (_event: unknown, ctx: ExtensionContext) => {
    connections.restore(ctx);
    jobs.restore(ctx);
    await desktop.close();
  };
  api.on("session_start", restore);
  api.on("session_switch", restore);
  api.on("session_branch", restore);
  api.on("session_tree", restore);
  api.on("session_shutdown", async () => {
    jobs.close();
    await desktop.close();
  });
  registerGuide(api, connections);
  registerTools(api, connections, jobs, desktop);
}
