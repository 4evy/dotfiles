import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { connect } from "../connections";
import { type Connections, connectionState } from "../connections/state";
import { createConnectionParameters } from "./schemas/connection";

export function registerConnectionTool(api: ExtensionAPI, { save }: Connections) {
  const { connectParameters } = createConnectionParameters(api);
  api.registerTool({
    name: "remote_connect",
    label: "Remote connection",
    description:
      "Connect and verify a generic SSH host; save its remote workspace profile.",
    parameters: connectParameters,
    loadMode: "discoverable",
    approval: "exec",
    async execute(_id, input, signal, _update, ctx) {
      const connection = await connect(connectParameters.parse(input), ctx.cwd, signal);
      save(connection);
      const multiplexing = await connectionState(connection, signal);
      return {
        content: [
          { type: "text", text: JSON.stringify({ connection, multiplexing }, null, 2) },
        ],
        details: { connection, multiplexing, verifiedAt: Date.now() },
      };
    },
  });
}
