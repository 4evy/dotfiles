import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { callTool } from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPToolCallResult } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { guideText, INSTRUCTIONS } from "./guides";
import { resultContent, skylightPresentation } from "./presentation";
import { createRuntime } from "./runtime";
import { LINUX } from "./runtime/paths";
import { createSkylightParameters } from "./schemas";

export default function skylight(api: ExtensionAPI) {
  if (process.platform !== "darwin" && !LINUX) return;
  const { guideParameters, parameters } = createSkylightParameters(api);

  const { serial, close, connect, releaseInput } = createRuntime();
  // The host validates completed inputs; call previews can still be partial
  api.registerTool({
    name: "skylight_guide",
    ...skylightPresentation(
      guideParameters,
      "Skylight guide",
      (input) => {
        const parsed = guideParameters.safeParse(input);
        return parsed.success ? parsed.data.topic : "Loading guidance";
      },
      true,
    ),
    description:
      'Read Skylight setup and usage guidance without starting the runtime. Begin with "start"; load other topics as needed.',
    loadMode: "essential",
    approval: "read",
    async execute(_id, { topic }) {
      return {
        content: [{ type: "text", text: await guideText(topic) }],
        details: { topic },
      };
    },
  });
  api.registerTool({
    name: "skylight",
    ...skylightPresentation(parameters, "Skylight", (input) =>
      typeof input?.title === "string"
        ? input.title
        : input?.reset
          ? "Reset runtime"
          : "Run JavaScript",
    ),
    description: INSTRUCTIONS,
    loadMode: "essential",
    approval: "exec",
    async execute(_id, args, signal, _update, ctx) {
      return serial.run(async () => {
        signal?.throwIfAborted();
        if (!args.reset && args.code === undefined)
          throw new Error("Provide code or reset:true");
        try {
          // Use the raw client: computer-use actions must never be auto-replayed
          const client = await connect(ctx, signal);
          const options = signal ? { signal } : {};
          let result: MCPToolCallResult | undefined;
          if (args.reset) {
            await releaseInput(client, signal);
            result = await callTool(client, "js_reset", {}, options);
          }
          if (!result?.isError && args.code !== undefined) {
            result = await callTool(
              client,
              "js",
              {
                code: args.code,
                ...(args.title ? { title: args.title } : {}),
                ...(args.timeout_ms ? { timeout_ms: args.timeout_ms } : {}),
              },
              options,
            );
          }
          if (!result) throw new Error("Skylight returned no result");
          return {
            content: resultContent(result),
            details: { isError: result.isError ?? false, meta: result._meta },
            ...(result.isError ? { isError: true } : {}),
          };
        } catch (error) {
          // Enqueuing close here would deadlock behind this running operation
          await close();
          throw error;
        }
      });
    },
  });

  // Lifecycle cleanup shares the action queue, including in headless sessions
  const discardRuntime = () => serial.run(close);
  api.on("session_switch", discardRuntime);
  api.on("session_branch", discardRuntime);
  api.on("session_tree", discardRuntime);
  api.on("session_shutdown", discardRuntime);
}
