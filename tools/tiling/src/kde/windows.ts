import type { Window } from "kwin-api";
import type { QRect } from "kwin-api/qt";

function isUnavailableForTiling(window: Window): boolean {
  return window.fullScreen || window.skipTaskbar || window.specialWindow;
}

export function focusedWindow(): Window | null {
  const window = workspace.activeWindow;
  return !window || isUnavailableForTiling(window) ? null : window;
}

export function canTileWindow(window: Window | null): window is Window {
  return Boolean(window?.moveable && window.resizeable);
}

export function moveResizeWindow(window: Window, rect: QRect) {
  window.setMaximize(false, false);
  window.frameGeometry = rect;
}
