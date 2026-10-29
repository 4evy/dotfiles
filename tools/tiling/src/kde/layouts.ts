import type { LayoutPreset } from "@dotfiles/tiling/shared";
import { resolveLayoutPresetRect } from "@dotfiles/tiling/shared";
import type { Window } from "kwin-api";
import { ClientAreaOption } from "kwin-api";
import type { QRect } from "kwin-api/qt";

export function resolveLayout(window: Window, preset: LayoutPreset): QRect {
  const workArea = workspace.clientArea(ClientAreaOption.MaximizeArea, window);

  return resolveLayoutPresetRect(workArea, window.frameGeometry, preset);
}
