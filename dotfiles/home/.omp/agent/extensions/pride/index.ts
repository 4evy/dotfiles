import type {
  ExtensionAPI,
  ExtensionContext,
  MessageUpdateEvent,
} from "@oh-my-pi/pi-coding-agent";
import type { Activity } from "./flags";
import { PrideFlags } from "./widget";

const STREAM_QUIET_MS = 500;
const STREAM_DELTAS: Readonly<
  Partial<Record<MessageUpdateEvent["assistantMessageEvent"]["type"], true>>
> = {
  text_delta: true,
  thinking_delta: true,
  toolcall_delta: true,
};

export default function pride(pi: ExtensionAPI) {
  let running = false;
  let lastDelta = Number.NEGATIVE_INFINITY;
  const tools = new Set<string>();
  let widget: PrideFlags | undefined;
  const activity = (now: number): Activity => {
    if (tools.size > 0) return "working";
    if (!running) return "idle";
    // A quiet stream is waiting for output, even if the request is still open
    return now - lastDelta < STREAM_QUIET_MS ? "streaming" : "waiting";
  };
  const setRunning = (value: boolean) => {
    running = value;
    lastDelta = Number.NEGATIVE_INFINITY;
    if (!running) tools.clear();
    widget?.tick();
  };
  const attach = (_event: unknown, ctx: ExtensionContext) => {
    running = !ctx.isIdle();
    lastDelta = Number.NEGATIVE_INFINITY;
    tools.clear();
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("pride", (tui) => {
      widget = new PrideFlags(ctx, tui, activity);
      return widget;
    });
  };
  pi.on("session_start", attach);
  pi.on("session_switch", attach);
  pi.on("agent_start", () => setRunning(true));
  pi.on("message_update", (event) => {
    const type = event.assistantMessageEvent.type;
    if (STREAM_DELTAS[type]) {
      lastDelta = performance.now();
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    lastDelta = Number.NEGATIVE_INFINITY;
    widget?.tick();
  });
  pi.on("tool_execution_start", (event) => {
    tools.add(event.toolCallId);
    widget?.tick();
  });
  pi.on("tool_execution_end", (event) => {
    tools.delete(event.toolCallId);
    widget?.tick();
  });
  pi.on("agent_end", () => setRunning(false));
  pi.on("session_shutdown", () => {
    widget?.dispose();
    widget = undefined;
  });
}
