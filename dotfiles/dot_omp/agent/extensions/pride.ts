import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Text, type TUI } from "@oh-my-pi/pi-tui";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";

type Activity = "idle" | "waiting" | "streaming" | "working";
type Rows = readonly [string, string, string, string];
type Pixels = readonly [Rows, Rows, Rows];

const FULL_TURN = 2 * Math.PI;
const FLAG_COLUMNS = 8;
const WIDGET_COLUMNS = 41;
const HALF_CELLS_PER_ROW = 2;
const CENTER_OFFSET = 1;

// First two positive roots of cosh(beta) * cos(beta) = -1 for a clamped-free beam
const FIRST_MODE_ROOT = 1.875104068711961;
const SECOND_MODE_ROOT = 4.694091132974175;

// Visual tuning: relative ripple amplitude and inter-flag phase spacing in radians
const RIPPLE_WEIGHT = 0.6;
const FLAG_PHASE_SPACING = 1.2;

const MS_PER_SECOND = 1000;
const TICK_MS = 100;
const STREAM_QUIET_MS = 500;
const RESPONSE_SECONDS = 0.25;

// Strength is measured in half-cells; period is measured in seconds
const MOTION: Record<Activity, { strength: number; periodSeconds: number }> = {
  idle: { strength: 0.65, periodSeconds: 7 },
  waiting: { strength: 0.95, periodSeconds: 3.5 },
  streaming: { strength: 1.35, periodSeconds: 1.4 },
  working: { strength: 1.45, periodSeconds: 1 },
};

// Precompute cantilever mode shapes once, not on animation ticks
// Tosi & Colonius, eqs 27–28: https://arxiv.org/abs/1903.03298
// Modal flag reconstruction: https://arxiv.org/abs/2602.06237 (section 3.2)
const WAVE_COLUMNS = (() => {
  const mode = (beta: number) => {
    const sigma =
      (Math.cosh(beta) + Math.cos(beta)) / (Math.sinh(beta) + Math.sin(beta));
    return (column: number) => {
      const x = (beta * column) / (FLAG_COLUMNS - 1);
      return Math.cosh(x) - Math.cos(x) - sigma * (Math.sinh(x) - Math.sin(x));
    };
  };
  const bendingMode = mode(FIRST_MODE_ROOT);
  const rippleMode = mode(SECOND_MODE_ROOT);
  const columns = Array.from({ length: FLAG_COLUMNS }, (_, column) => ({
    bend: bendingMode(column),
    ripple: RIPPLE_WEIGHT * rippleMode(column),
  }));
  const peak = Math.max(...columns.map(({ bend, ripple }) => Math.hypot(bend, ripple)));
  for (const column of columns) {
    column.bend /= peak;
    column.ripple /= peak;
  }
  return columns;
})();

const STRIPES: Record<"trans" | "bi" | "rainbow", readonly string[]> = {
  trans: ["#5bcefa", "#f5a9b8", "#ffffff", "#f5a9b8", "#5bcefa"],
  bi: ["#d60270", "#d60270", "#9b4f96", "#0038a8", "#0038a8"],
  rainbow: ["#e40303", "#ff8c00", "#ffed00", "#008026", "#004dff", "#750787"],
};

function flagPixels(stripes: readonly string[]): Pixels {
  const colors = stripes.map((color) => {
    const foreground = Bun.color(color, "ansi-16m");
    if (!foreground) throw new Error(`Invalid flag color: ${color}`);
    return { foreground, background: foreground.replace("[38;", "[48;") };
  });
  const pixel = (offset: number, row: number) => {
    const top = colors[row * HALF_CELLS_PER_ROW - offset];
    const bottom = colors[row * HALF_CELLS_PER_ROW + 1 - offset];
    if (top && bottom) return `${top.foreground}${bottom.background}▀\x1b[0m`;
    if (top) return `${top.foreground}▀\x1b[0m`;
    if (bottom) return `${bottom.foreground}▄\x1b[0m`;
    return " ";
  };
  const rows = (offset: number): Rows => [
    pixel(offset, 0),
    pixel(offset, 1),
    pixel(offset, 2),
    pixel(offset, 3),
  ];
  return [rows(0), rows(CENTER_OFFSET), rows(2 * CENTER_OFFSET)];
}

const flags = {
  trans: flagPixels(STRIPES.trans),
  bi: flagPixels(STRIPES.bi),
  rainbow: flagPixels(STRIPES.rainbow),
};

// The clamped edge stays still; phase-shifted bending modes ripple toward the tip
// The sampled envelope is at most one, keeping all stripes in four fixed rows
function wave(pixels: Pixels, phase: number, strength: number): Rows {
  const rows: [string, string, string, string] = ["", "", "", ""];
  const bend = Math.sin(phase) * strength;
  const ripple = Math.cos(phase) * strength;
  for (const shape of WAVE_COLUMNS) {
    const offset = (CENTER_OFFSET +
      Math.round(bend * shape.bend + ripple * shape.ripple)) as 0 | 1 | 2;
    const [top, upper, lower, bottom] = pixels[offset];
    rows[0] += top;
    rows[1] += upper;
    rows[2] += lower;
    rows[3] += bottom;
  }
  return rows;
}

class PrideFlags extends Text {
  readonly #timer: Timer;
  readonly ctx: ExtensionContext;
  readonly tui: TUI;
  readonly activity: (now: number) => Activity;
  #lastTick = performance.now();
  #phase = 0;
  #strength = MOTION.idle.strength;
  #speed = FULL_TURN / MOTION.idle.periodSeconds;
  #activity: Activity = "idle";
  #reduceMotion = false;
  #disposed = false;
  #native: { text: string; activity: Activity; node: NativeNode } | undefined;

  constructor(ctx: ExtensionContext, tui: TUI, activity: (now: number) => Activity) {
    super("pride", 0, 0);
    this.ctx = ctx;
    this.tui = tui;
    this.activity = activity;
    this.tick();
    this.#timer = ctx.setInterval(() => this.tick(), TICK_MS);
  }

  tick(): void {
    if (this.#disposed) return;
    const now = performance.now();
    const elapsed = (now - this.#lastTick) / MS_PER_SECOND;
    this.#lastTick = now;
    const previous = this.#activity;
    // Use the closed-form relaxation and its speed integral so phase does not
    // depend on tick cadence. Advance using the previous target, which governed
    // the elapsed interval
    const motion = MOTION[previous];
    const targetSpeed = FULL_TURN / motion.periodSeconds;
    const blend = -Math.expm1(-elapsed / RESPONSE_SECONDS);
    if (!this.#reduceMotion) {
      const advance =
        targetSpeed * elapsed + (this.#speed - targetSpeed) * RESPONSE_SECONDS * blend;
      this.#phase = (this.#phase + advance) % FULL_TURN;
    }
    this.#strength += (motion.strength - this.#strength) * blend;
    this.#speed += (targetSpeed - this.#speed) * blend;
    this.#activity = this.activity(now);
    if (this.#paint() || previous !== this.#activity) this.tui.requestRender();
  }

  #paint(): boolean {
    const phase = this.#reduceMotion ? 0 : this.#phase;
    const strength = this.#reduceMotion ? 0 : this.#strength;
    const trans = wave(flags.trans, phase, strength);
    const bi = wave(flags.bi, phase + FLAG_PHASE_SPACING, strength);
    const rainbow = wave(flags.rainbow, phase + 2 * FLAG_PHASE_SPACING, strength);
    const theme = this.ctx.ui.theme;
    return this.setText(
      [
        ` ${theme.fg("statusLinePath", "✧")}  ${trans[0]}  ${theme.fg("accent", "✦")}  ${bi[0]}  ${theme.fg("warning", "⋆")}  ${rainbow[0]}`,
        `    ${trans[1]}     ${bi[1]}     ${rainbow[1]}`,
        `    ${trans[2]}     ${bi[2]}     ${rainbow[2]}`,
        ` ${theme.fg("accent", "·")}  ${trans[3]}  ${theme.fg("syntaxKeyword", "⋆")}  ${bi[3]}  ${theme.fg("statusLinePath", "✧")}  ${rainbow[3]}  ${theme.fg("accent", "·")}`,
      ].join("\n"),
    );
  }

  override describe(cx: DescribeContext): NativeNode {
    if (cx.reduceMotion !== this.#reduceMotion) {
      this.#reduceMotion = cx.reduceMotion;
      this.#paint();
    }
    const text = this.getText();
    if (this.#native?.text !== text || this.#native.activity !== this.#activity) {
      // ANSI retains the RGB backgrounds of the half-block pixels
      const described = node("ansi", {
        text,
        cols: WIDGET_COLUMNS,
        role: "omp.pride.flags",
        aria: `Trans, bisexual, and rainbow flags; ${this.#activity}`,
      });
      this.#native = { text, activity: this.#activity, node: described };
    }
    return this.#native.node;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.ctx.clearTimer(this.#timer);
  }
}

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
  pi.on("agent_start", () => {
    running = true;
    lastDelta = Number.NEGATIVE_INFINITY;
    widget?.tick();
  });
  pi.on("message_update", (event) => {
    const type = event.assistantMessageEvent.type;
    if (
      type === "text_delta" ||
      type === "thinking_delta" ||
      type === "toolcall_delta"
    ) {
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
  pi.on("agent_end", () => {
    running = false;
    lastDelta = Number.NEGATIVE_INFINITY;
    tools.clear();
    widget?.tick();
  });
  pi.on("session_shutdown", () => {
    widget?.dispose();
    widget = undefined;
  });
}
