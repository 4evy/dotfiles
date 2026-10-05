import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { z as schemaZ } from "zod";
import type { Connections } from "../connections/state";
import type { DesktopOperations } from "../desktop";
import { createDesktopParameters } from "./schemas/desktop";

export function registerDesktopTools(
  api: ExtensionAPI,
  { selected }: Connections,
  { desktop, screenshot, input: submitInput }: DesktopOperations,
) {
  const { desktopParameters, screenshotParameters, inputParameters } =
    createDesktopParameters(api);
  api.registerTool({
    name: "remote_desktop",
    label: "Remote desktop",
    description:
      "Inspect capabilities, open a URI in an isolated Linux workspace, authorize/release portal control, or release an opened workspace. Only inspect is read-approved.",
    parameters: desktopParameters,
    loadMode: "discoverable",
    approval: (input) => {
      const parsed = desktopParameters.safeParse(input);
      return parsed.success && parsed.data.action === "inspect" ? "read" : "exec";
    },
    async execute(_id, input, signal, _update, ctx) {
      const args = desktopParameters.parse(input);
      return desktop(selected(args.connection), args, ctx, signal);
    },
  });
  api.registerTool({
    name: "remote_screenshot",
    label: "Remote screenshot",
    description:
      "Capture a user-selected remote monitor or window as an image with actionable frame metadata. Capture alone never grants input.",
    parameters: screenshotParameters,
    loadMode: "discoverable",
    approval: "read",
    async execute(_id, input, signal, _update, ctx) {
      const args = screenshotParameters.parse(input);
      return screenshot(selected(args.connection), args, ctx, signal);
    },
  });
  api.registerTool({
    name: "remote_input",
    label: "Remote desktop input",
    description:
      "Submit input to an explicitly authorized desktop session. Pointer actions require the latest captured frame; text receipts report clipboard effects and partial submission.",
    parameters: schemaZ.toJSONSchema(inputParameters),
    loadMode: "discoverable",
    approval: "exec",
    async execute(_id, input, signal, _update, ctx) {
      const { connection, ...args } = inputParameters.parse(input);
      return submitInput(selected(connection), args, ctx, signal);
    },
  });
}
