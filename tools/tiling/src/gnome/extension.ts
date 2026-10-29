import Meta from "gi://Meta";
import Shell from "gi://Shell";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import { wm } from "resource:///org/gnome/shell/ui/main.js";
import type { BindingName, LayoutPreset } from "@dotfiles/tiling/shared";
import {
  advanceCycle,
  BINDING_NAMES,
  BINDINGS,
  createCycleState,
} from "@dotfiles/tiling/shared";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import { resolveLayout } from "./layouts.js";
import { native } from "./native.js";
import {
  canMoveResizeWindow,
  createWindowOperations,
  focusedWindow,
} from "./windows.js";

export default class HyperWindowTilingExtension extends Extension {
  private scope: Scope.Closeable | null = null;

  enable() {
    const scope = Scope.makeUnsafe();
    const extension = this;
    // GJS owns the event loop. Disabling cooperative yields keeps runSync off
    // Effect's Promise/timer dispatcher, including during scope finalization
    Effect.runSync(
      Effect.gen(function* () {
        const settings = yield* native("load extension settings", () =>
          extension.getSettings(),
        );
        const { moveResizeWindow } = yield* createWindowOperations;
        const cycle = createCycleState();

        const applyLayout = Effect.fn(function* (
          preset: LayoutPreset | readonly LayoutPreset[],
          bindingName: BindingName,
        ) {
          const window = yield* focusedWindow;
          if (!window || !(yield* canMoveResizeWindow(window))) return;

          const now = yield* Clock.currentTimeMillis;
          const layout =
            typeof preset === "string"
              ? preset
              : preset[advanceCycle(cycle, bindingName, preset.length, now)];
          yield* moveResizeWindow(window, yield* resolveLayout(window, layout));
        });

        yield* Effect.forEach(BINDING_NAMES, (bindingName) => {
          const binding = BINDINGS[bindingName];
          const handler = () => {
            // GNOME invokes this synchronous foreign-runtime callback
            Effect.runSync(
              applyLayout(
                binding.action === "cycle" ? binding.presets : "maximize",
                bindingName,
              ).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
            );
          };
          return Effect.acquireRelease(
            native("register window tiling binding", () =>
              wm.addKeybinding(
                bindingName,
                settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL,
                handler,
              ),
            ),
            () =>
              native("remove window tiling binding", () =>
                wm.removeKeybinding(bindingName),
              ).pipe(Effect.orDie),
          );
        });
      }).pipe(
        Scope.provide(scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        Effect.provideService(Scheduler.PreventSchedulerYield, true),
      ),
    );
    this.scope = scope;
  }

  disable() {
    const scope = this.scope;
    this.scope = null;
    if (!scope) return;

    Effect.runSync(
      Scope.close(scope, Exit.void).pipe(
        Effect.provideService(Scheduler.PreventSchedulerYield, true),
      ),
    );
  }
}
