import {
  advanceCycle,
  type BindingName,
  createCycleState,
  type LayoutPreset,
} from "@dotfiles/tiling/shared";
import { resolveLayout } from "./layouts.js";
import { canTileWindow, focusedWindow, moveResizeWindow } from "./windows.js";

export function createTilingController() {
  const cycle = createCycleState();

  return {
    applyCycle(bindingName: BindingName, layouts: readonly LayoutPreset[]) {
      const window = focusedWindow();
      if (!canTileWindow(window)) return;

      const rect = resolveLayout(
        window,
        layouts[advanceCycle(cycle, bindingName, layouts.length, Date.now())],
      );

      moveResizeWindow(window, rect);
    },

    maximizeFocusedWindow() {
      const window = focusedWindow();
      if (!canTileWindow(window)) return;

      moveResizeWindow(window, resolveLayout(window, "maximize"));
    },
  };
}
