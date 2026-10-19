import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  ansi,
  type DescribeContext,
  type NativeNode,
  Text,
  type TUI,
} from "@oh-my-pi/pi-tui";
import {
  type Activity,
  FLAG_PHASE_SPACING,
  FULL_TURN,
  MOTION,
  RENDERED_FLAGS,
  ROW_INDICES,
  type Rows,
  WIDGET_COLUMNS,
  wave,
} from "./flags";

const MS_PER_SECOND = 1000;
const TICK_MS = 100;
const RESPONSE_SECONDS = 0.25;

export class PrideFlags extends Text {
  readonly #timer: Timer;
  readonly ctx: ExtensionContext;
  readonly tui: TUI;
  readonly activity: (now: number) => Activity;
  #lastTick = performance.now();
  #phase = 0;
  #strength: number = MOTION.idle.strength;
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
    // Use the closed-form relaxation and its speed integral so phase does not depend
    // on tick cadence. Advance using the previous target, which governed the elapsed
    // interval
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
    const theme = this.ctx.ui.theme;
    const rows: [...Rows] = ["", "", "", ""];
    let index = 0;
    for (const flag of RENDERED_FLAGS) {
      const pixels = wave(flag.pixels, phase + index * FLAG_PHASE_SPACING, strength);
      for (const row of ROW_INDICES) {
        const decoration = flag.decorations[row];
        const prefix = decoration
          ? ` ${theme.fg(decoration[0], decoration[1])}  `
          : "    ";
        rows[row] += `${index ? " " : ""}${prefix}${pixels[row]}`;
      }
      index++;
    }
    rows[3] += `  ${theme.fg("accent", "·")}`;
    return this.setText(rows.join("\n"));
  }

  override describe(cx: DescribeContext): NativeNode {
    if (cx.reduceMotion !== this.#reduceMotion) {
      this.#reduceMotion = cx.reduceMotion;
      this.#paint();
    }
    const text = this.getText();
    if (this.#native?.text !== text || this.#native.activity !== this.#activity) {
      // ANSI retains the RGB backgrounds of the half-block pixels
      const described = ansi(text, {
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
