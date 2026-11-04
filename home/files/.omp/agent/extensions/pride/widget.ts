import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  ansi,
  type DescribeContext,
  type NativeNode,
  Text,
  type TUI,
} from "@oh-my-pi/pi-tui";
import { Effect, Fiber, Schedule } from "effect";
import {
  type Activity,
  FLAG_NAMES,
  FULL_TURN,
  MOTION,
  renderBanner,
  TWINKLE_SECONDS,
  WIDGET_COLUMNS,
} from "./flags";

const MS_PER_SECOND = 1000;
const TICK_MS = 100;
const RESPONSE_SECONDS = 0.25;

export class PrideFlags extends Text {
  readonly #animation: Fiber.Fiber<void>;
  readonly ctx: ExtensionContext;
  readonly tui: TUI;
  readonly activity: (now: number) => Activity;
  #lastTick = performance.now();
  #phase = 0;
  #starPhase = 0;
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
    // The SDK owns construction/disposal, so these are runtime boundaries
    this.#animation = Effect.runFork(
      Effect.sync(() => this.tick()).pipe(
        Effect.schedule(Schedule.spaced(TICK_MS)),
        Effect.asVoid,
      ),
    );
  }

  tick(): void {
    if (this.#disposed) return;
    const now = performance.now();
    const elapsed = (now - this.#lastTick) / MS_PER_SECOND;
    this.#lastTick = now;
    const previous = this.#activity;
    // Integrate the original wave relaxation independently of timer cadence
    const motion = MOTION[previous];
    const targetSpeed = FULL_TURN / motion.periodSeconds;
    const blend = -Math.expm1(-elapsed / RESPONSE_SECONDS);
    if (!this.#reduceMotion) {
      const advance =
        targetSpeed * elapsed + (this.#speed - targetSpeed) * RESPONSE_SECONDS * blend;
      this.#phase = (this.#phase + advance) % FULL_TURN;
      // Star twinkle keeps its own gentle cadence through activity changes
      this.#starPhase =
        (this.#starPhase + (elapsed * FULL_TURN) / TWINKLE_SECONDS) % FULL_TURN;
    }
    this.#strength += (motion.strength - this.#strength) * blend;
    this.#speed += (targetSpeed - this.#speed) * blend;
    this.#activity = this.activity(now);
    // Frozen pixels refresh through invalidation, not the activity timer
    const painted = !this.#reduceMotion && this.#paint();
    if (painted || previous !== this.#activity) this.tui.requestRender();
  }

  #paint(): boolean {
    return this.setText(
      renderBanner(
        this.ctx.ui.theme,
        this.#reduceMotion ? 0 : this.#starPhase,
        this.#reduceMotion ? 0 : this.#phase,
        this.#reduceMotion ? 0 : this.#strength,
      ),
    );
  }

  override invalidate(): void {
    super.invalidate();
    this.#paint();
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
        aria: `${FLAG_NAMES} flags; ${this.#activity}`,
      });
      this.#native = { text, activity: this.#activity, node: described };
    }
    return this.#native.node;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    Effect.runFork(Fiber.interrupt(this.#animation));
  }
}
