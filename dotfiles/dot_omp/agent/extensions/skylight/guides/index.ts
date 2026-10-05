import { join } from "node:path";
import { LINUX, MODULES } from "../runtime/paths";
import { LINUX_GUIDES } from "./linux";
import { MAC_GUIDES } from "./macos";

const platform = LINUX
  ? {
      name: "Linux desktop",
      guides: LINUX_GUIDES,
      reference: "sky-full-desktop-api.md",
      screenshotExpression: "shot.data_url",
      screenshotValue: "data_url",
    }
  : {
      name: "macOS",
      guides: MAC_GUIDES,
      reference: "sky-window-api.md",
      screenshotExpression: "state.screenshot.url",
      screenshotValue: "URL",
    };

export const INSTRUCTIONS = `Control ${platform.name} apps with Skylight.
Read skylight_guide's "start" topic first; load other topics as needed.
JavaScript bindings persist in a Node REPL separate from omp eval.
Use nodeRepl.write for text and await nodeRepl.emitImage(${platform.screenshotExpression})
for screenshots; a captured ${platform.screenshotValue} alone is not displayed.
Prefer dedicated APIs/CLIs when they suffice. Retain the user's permissions and
app-access policy. Observe after interrupted actions; never replay automatically.`;

export const GUIDE_TOPICS = [
  "start",
  "actions",
  "screenshots",
  "recovery",
  "api",
] as const;
export type Guide = (typeof GUIDE_TOPICS)[number];

export async function guideText(guide: Guide) {
  if (guide !== "api") return platform.guides[guide];
  const path = join(MODULES, "@oai/sky/docs", platform.reference);
  const reference = await Bun.file(path).text();
  return `# Installed Skylight API reference

Source: ${path}
Use the dynamic import in "start" to initialize the REPL; the declarations
below describe inputs, not bootstrap code. See "screenshots" for capture and
display; emitImage accepts the returned ${platform.screenshotValue}.

${reference}${
  LINUX
    ? `

## Linux additions

The adapter exposes only get_screenshot, click, move, press_key, type_text,
scroll, drag, and drag_handle. Other methods and accessibility targets in
the reference are unavailable.

get_screenshot(options?: {outputName?: string}) adds a Linux-only output
binding. Follow "start" for direct input's explicit user choice and consent.

type_text adds paste_key, such as "Control_L+Shift_L+v", and returns status,
mechanism, clipboardChanged, submittedBytes, and partial. Error receipts also
include code/message. See "actions" for clipboard effects and receipt handling,
and "screenshots" for the latest-frame pixel mapping.
`
    : ""
}`;
}
