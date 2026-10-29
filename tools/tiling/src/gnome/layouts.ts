import type Meta from "gi://Meta";
import Mtk from "gi://Mtk";
import type { LayoutPreset } from "@dotfiles/tiling/shared";
import {
  fitLayoutPresetRectToMinimumSize,
  resolveLayoutPresetRect,
} from "@dotfiles/tiling/shared";
import * as Effect from "effect/Effect";
import { native } from "./native.js";

export const resolveLayout = Effect.fn(function* (
  window: Meta.Window,
  preset: LayoutPreset,
) {
  const { workArea, current, minimum } = yield* native("read window geometry", () => ({
    workArea: window.get_work_area_current_monitor(),
    current: window.get_frame_rect(),
    minimum: window.get_min_size(),
  }));
  let rect = resolveLayoutPresetRect(workArea, current, preset);
  const [hasMinSize, minWidth, minHeight] = minimum;
  if (hasMinSize) {
    rect = fitLayoutPresetRectToMinimumSize(workArea, rect, preset, {
      width: minWidth,
      height: minHeight,
    });
  }

  return yield* native("create native window rectangle", () =>
    Mtk.Rectangle.new(rect.x, rect.y, rect.width, rect.height),
  );
});
