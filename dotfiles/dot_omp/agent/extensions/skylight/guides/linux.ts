import type { Guide } from ".";

const OBSERVE = `var shots = await sky.get_screenshot();
for (var shot of shots) await nodeRepl.emitImage(shot.data_url);`;

export const LINUX_GUIDES = {
  start: `# Observe the selected Wayland monitor

Run snippets in skylight's code parameter. Requires omp-helper running as the
graphical user, an active Wayland session, its session bus, and XDG_RUNTIME_DIR.
X11 is unsupported. Linux has no accessibility tree or app targeting.

OMP-managed headed browsers and supported native GUI launches use the helper's
GNOME workspace adapter. They start on dedicated inactive workspaces; missing
adapter prerequisites fail before launch. Capture and input still target the
user-selected monitor, not an inactive workspace.

Initialize once per fresh kernel with a dynamic import:

\`\`\`js
var sky = (await import("@oai/sky")).sky;
\`\`\`

For GNOME/KDE portal input, capture without an output binding:

\`\`\`js
${OBSERVE}
\`\`\`

The first capture requests portal authorization; the user selects the source
and consents. Import and guide reads do not grant access, and restore tokens
do not bypass consent.

Where RemoteDesktop is unavailable, Sway/Hyprland may support input authorized
by the compositor socket, separately from capture consent. Inspect helper
capabilities first. For direct input, obtain the user's explicit compositor
output name and pass it as userSelectedOutputName below; never infer it:

\`\`\`js
var shots = await sky.get_screenshot({outputName: userSelectedOutputName});
for (var shot of shots) await nodeRepl.emitImage(shot.data_url);
\`\`\`

The user must select the same monitor in the portal. Later captures reuse the
binding; reset before changing outputs. Load "actions" before input.
Capture after each action to verify the app accepted it. Emit the initial
state and verified result as images.`,
  actions: `# Act on the latest frame

Use pixels from the latest screenshot, not desktop coordinates. Capture again
after geometry, scale, rotation, or output changes; ambiguous mapping cannot
drive pointer input. Choose observedX and observedY from that frame:

\`\`\`js
await sky.click({x: observedX, y: observedY});
${OBSERVE}
\`\`\`

Once focus is verified, replace text and inspect both the receipt and app:

\`\`\`js
await sky.press_key({key: "Control_L+a"});
var receipt = await sky.type_text({text: "replacement text"});
nodeRepl.write(receipt);
${OBSERVE}
\`\`\`

Inspect status, mechanism, clipboardChanged, submittedBytes, and partial.
Text uses native EI input or clipboard paste with Ctrl+V; for terminals, pass
paste_key:"Control_L+Shift_L+v". Paste changes clipboard ownership, may enter
history, and does not restore the previous clipboard, even after failure.
Newlines may submit forms or commands. Without native text or authorized
clipboard access, typing fails before submitting a partial string.

Do not replay partial or interrupted input; inspect the app first.
Keys use keysym names such as Return and Control_L+a. Load "api" for signatures.
Finish a drag_handle with end() before unrelated input. Reset, abort, or
connection loss releases held keys and buttons.`,
  screenshots: `# Display the selected monitor

get_screenshot(options?: {outputName?: string}) returns an array of screenshots
with filepath, data_url, and decoded bytes. Emit each data URL as image content,
not base64 text:

\`\`\`js
${OBSERVE}
\`\`\`

Only the latest frame for the current session and geometry can drive input.
Capture can succeed without an authoritative pointer mapping; do not guess
coordinates when mapping is unavailable. Follow "start" for output binding.
Screenshot files are private and removed when the runtime closes; do not reuse
their paths after reset or session changes.`,
  recovery: `# Recover without replaying uncertain input

An interrupted action may already have executed. Observe before deciding what
input remains. Normal JS errors do not require reset; to clear bindings and
release input, call skylight with {reset:true}, then initialize and capture again.

Cancellation, denial, or revocation ends the operation. Do not approve portal
dialogs for the user or change backends to bypass consent. EIS failure does not
fall back to Notify or direct input. Session/device loss invalidates access.
Recapture stale frames; reset before binding a different user-selected output.

For setup errors, inspect helper status, the graphical user service,
WAYLAND_DISPLAY, XDG_RUNTIME_DIR, and session bus. Installation does not create
a graphical session or enable lingering. Missing portal/compositor protocols
are capability limits, not reasons to use GJS/XTEST.

timeout_ms defaults to 30000 ms; helper calls also have a 30-second deadline.
Increase the cell deadline only for a known slow operation, not a stalled
permission or backend request.`,
} satisfies Record<Exclude<Guide, "api">, string>;
