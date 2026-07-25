import type { Window } from "kwin-api";
import { ClientAreaOption } from "kwin-api";
import type { QRect } from "kwin-api/qt";
import type { LayoutPreset } from "../shared/lib.js";
import { resolveLayoutPresetRect } from "../shared/lib.js";

export function resolveLayout(window: Window, preset: LayoutPreset): QRect {
  const workArea = workspace.clientArea(ClientAreaOption.MaximizeArea, window);

  return resolveLayoutPresetRect(workArea, window.frameGeometry, preset);
}
