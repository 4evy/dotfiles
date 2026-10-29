import type {
  ExtensionAPI,
  ExtensionContext,
  MessageUpdateEvent,
} from "@oh-my-pi/pi-coding-agent";
import { Effect } from "effect";
import type { Activity } from "./flags";
import { PrideFlags } from "./widget";

const STREAM_QUIET_MS = 500;
const STREAM_DELTAS = {
  text_delta: true,
  thinking_delta: true,
  toolcall_delta: true,
} as const satisfies Partial<
  Record<MessageUpdateEvent["assistantMessageEvent"]["type"], true>
>;

export default function pride(pi: ExtensionAPI) {
  let enabled = true;
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
    tools.clear();
    widget?.tick();
  };
  const detach = (ctx: ExtensionContext) => {
    widget = undefined;
    if (ctx.hasUI) ctx.ui.setWidget("pride", undefined);
  };
  const updateWidget = (ctx: ExtensionContext) => {
    if (!enabled || !ctx.hasUI) {
      detach(ctx);
      return;
    }
    // The UI registry disposes the previous widget before creating its replacement
    widget = undefined;
    ctx.ui.setWidget("pride", (tui) => {
      widget = new PrideFlags(ctx, tui, activity);
      return widget;
    });
  };
  const attach = (_event: unknown, ctx: ExtensionContext) => {
    running = !ctx.isIdle();
    lastDelta = Number.NEGATIVE_INFINITY;
    tools.clear();
    updateWidget(ctx);
  };
  pi.registerCommand("pride", {
    description: "Toggle animated pride flags",
    // The command API requires a Promise at this native SDK callback boundary
    handler: (_args, ctx) =>
      Effect.runPromise(
        Effect.sync(() => {
          if (!ctx.hasUI) return;
          enabled = !enabled;
          updateWidget(ctx);
        }),
      ),
  });
  // SDK events mutate UI-owned state synchronously, animation runs in a fiber
  pi.on("session_start", attach);
  pi.on("session_switch", attach);
  pi.on("agent_start", () => setRunning(true));
  pi.on("message_update", (event) => {
    const type = event.assistantMessageEvent.type;
    if (Object.hasOwn(STREAM_DELTAS, type)) {
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
  // Nonterminal settles still expect output from a continuation or background work
  pi.on("agent_end", (event) => setRunning(event.willContinue === true));
  pi.on("session_shutdown", (_event, ctx) => detach(ctx));
}
