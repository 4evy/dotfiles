import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Connections } from "../../connections/state";
import { createFileParameters } from "../schemas/files";
import { registerDeleteTool } from "./delete";
import { registerEditTool } from "./edit";
import { registerReadTool } from "./read";
import { registerWriteTool } from "./write";

export function registerFileTools(api: ExtensionAPI, connections: Connections) {
  const parameters = createFileParameters(api);
  registerReadTool(api, connections, parameters);
  registerWriteTool(api, connections, parameters);
  registerEditTool(api, connections, parameters);
  registerDeleteTool(api, connections, parameters);
}
