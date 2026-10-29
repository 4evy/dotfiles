import GLib from "gi://GLib";
import Meta from "gi://Meta";
import type Mtk from "gi://Mtk";
import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";
import { native } from "./native.js";

const MOVE_RESIZE_RETRY_DELAY_MS = 75;
const IGNORED_WINDOW_TYPES = new Set([Meta.WindowType.DESKTOP, Meta.WindowType.DOCK]);

export const focusedWindow = native("read focused window", () => {
  const window = global.display.focus_window;
  if (!window) return null;

  return [
    window.is_override_redirect(),
    window.is_fullscreen(),
    window.is_skip_taskbar(),
    IGNORED_WINDOW_TYPES.has(window.get_window_type()),
  ].some(Boolean)
    ? null
    : window;
});

export function canMoveResizeWindow(window: Meta.Window) {
  return native("read window capabilities", () =>
    window.get_maximize_flags()
      ? window.can_maximize()
      : window.allows_move() && window.allows_resize(),
  );
}

export const createWindowOperations = Effect.gen(function* () {
  const serials = new WeakMap<Meta.Window, number>();
  // GLib owns dispatch, while the extension scope owns every pending source
  const sources = yield* Effect.acquireRelease(
    Effect.sync(() => new Set<number>()),
    (pending) =>
      Effect.forEach(pending, (source) =>
        native("remove pending window resize", () => GLib.Source.remove(source)),
      ).pipe(Effect.orDie),
  );

  const moveResizeWindow = Effect.fn(function* (
    window: Meta.Window,
    rect: Mtk.Rectangle,
  ) {
    const serial = (serials.get(window) ?? 0) + 1;
    serials.set(window, serial);

    const maximized = yield* native("read maximize state", () =>
      window.get_maximize_flags(),
    );
    if (maximized) {
      yield* native("unmaximize window", () => {
        window.set_unmaximize_flags(Meta.MaximizeFlags.BOTH);
        window.unmaximize();
      });
    }
    yield* moveResizeFrame(window, rect);
    const source = yield* native("schedule window resize retry", () =>
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, MOVE_RESIZE_RETRY_DELAY_MS, () => {
        // Native callbacks are synchronous. Never use Effect.sleep or fork here
        Effect.runSync(
          Effect.gen(function* () {
            const alive = yield* native(
              "read retry window state",
              () => window.is_alive,
            );
            if (alive && serials.get(window) === serial) {
              yield* moveResizeFrame(window, rect);
            }
          }).pipe(
            Effect.ensuring(Effect.sync(() => sources.delete(source))),
            Effect.provideService(Scheduler.PreventSchedulerYield, true),
          ),
        );
        return GLib.SOURCE_REMOVE;
      }),
    );
    sources.add(source);
  });

  return { moveResizeWindow };
});

function moveResizeFrame(window: Meta.Window, rect: Mtk.Rectangle) {
  return native("move and resize window", () =>
    window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height),
  );
}
