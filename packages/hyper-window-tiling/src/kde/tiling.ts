import {
  advanceCycle,
  CYCLE_LAYOUT_PRESETS,
  type CycleBindingName,
  createCycleState,
} from "../shared/lib.js";
import { resolveLayout } from "./layouts.js";
import { canTileWindow, focusedWindow, moveResizeWindow } from "./windows.js";

export function createTilingController() {
  const cycle = createCycleState();

  return {
    applyCycle(bindingName: CycleBindingName) {
      const window = focusedWindow();
      if (!canTileWindow(window)) return;

      const layouts = CYCLE_LAYOUT_PRESETS[bindingName];
      const rect = resolveLayout(
        window,
        layouts[advanceCycle(cycle, bindingName, layouts.length)],
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
