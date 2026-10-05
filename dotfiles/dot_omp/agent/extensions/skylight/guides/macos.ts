import type { Guide } from ".";

const OBSERVE = `state = await sky.get_app_state({ app });
nodeRepl.write(state.text);
if (state.screenshot) await nodeRepl.emitImage(state.screenshot.url);`;

// Codex's VM accepts dynamic imports only; these examples run there, not in omp
export const MAC_GUIDES = {
  start: `# Observe the app before acting

Run snippets in skylight's code parameter. Initialize once per fresh kernel:

\`\`\`js
var sky = (await import("@oai/sky")).sky;
var app = "Calculator"; // Replace with the task's app name
var ${OBSERVE}
\`\`\`

Use an app name, bundle ID, or full path. get_app_state launches the app if
needed; launches and actions can change desktop focus. Skylight does not
isolate apps in a separate Space or relocate dialogs. If the target is unknown,
list apps with nodeRepl.write(JSON.stringify(await sky.list_apps())).

Read the accessibility tree, load "actions", and choose a target from that
observation. After acting, fetch fresh state before choosing the next target;
indices can change. Show the initial state and verified result with emitImage,
plus intermediate images when useful.

State text is a diff by default. Pass disableDiff:true when the previous tree
is missing from context or you need a full view. Load "screenshots" for image
handling and "api" before using an unfamiliar method.`,
  actions: `# Act on the latest app state

Use element_index from the latest accessibility tree, never an example index.
Perform one indexed action, then observe again before choosing another index:
even clearing a field can renumber controls. A short keyboard/typing sequence
is safe only when focus is known and no intermediate UI decision is needed.

\`\`\`js
${OBSERVE}
\`\`\`

Load "api" for method signatures. Key chords use xdotool-style names, such as
Return or super+c. type_text simulates Return for newlines, which may submit
a form or send a message. Prefer paste for multiline or formatted content;
specify text, md, or html. Paste restores the previous clipboard contents.

Use secondary actions only when the tree exposes them; do not guess action
names. If accessibility cannot identify a control, inspect a fresh screenshot
and use window-relative coordinates. The runtime waits for state capture after
actions, so do not add arbitrary sleeps.

Pointer actions already use ChatGPT's animated virtual cursor. Do not add
clicks, move the physical pointer, or invent cursor show/hide or animation
methods to indicate activity.`,
  screenshots: `# Show the app window and its accessibility text

Capture both from the same observation, then emit the image:

\`\`\`js
state = await sky.get_app_state({ app });
nodeRepl.write(state.text);
if (state.screenshot) {
  await nodeRepl.emitImage(state.screenshot.url);
} else {
  nodeRepl.write("No screenshot available for this state");
}
\`\`\`

emitImage accepts file URLs and data URLs and detects the image format.
Do not relabel JPEG bytes as PNG. Coordinates are relative to the captured
app window, not the desktop.

Keep images as tool content, not base64 text or Markdown links. They appear
in chat and reach the model; terminals without inline images show a fallback.
The native cursor may appear in a screenshot, but its animation is not recorded.`,
  recovery: `# Observe before retrying

An interrupted or timed-out action may already have executed. Fetch fresh app
state before deciding whether more input is needed; never replay automatically.
If an app name cannot be resolved, use sky.list_apps() to find its bundle ID
and retry observation, not a mutating action.

If the user stops or intervenes, stop acting. Do not reset or replay to defeat
that choice. A locked screen or pending permissions need the user's attention.
Missing runtime files, permission failures, or incompatible client/service
versions need repair, not a different input method.

Normal JS errors do not require reset. To clear bindings, call skylight with
{reset:true}, then initialize using "start". Reset clears this REPL, not omp
eval. New, switch, branch, tree, and shutdown sessions discard the runtime.

timeout_ms defaults to 30000 ms. Increase it only for a known slow operation,
not to conceal a stalled action.`,
} satisfies Record<Exclude<Guide, "api">, string>;
