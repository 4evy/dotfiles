import type { BindingName, CycleBindingName } from "../shared/lib.js";
import { CYCLE_BINDING_NAMES, MAXIMIZE_BINDING_NAME } from "../shared/lib.js";

type ShortcutHandlers = {
  applyCycle: (bindingName: CycleBindingName) => void;
  maximizeFocusedWindow: () => void;
};

const CYCLE_SHORTCUTS = {
  "move-up": ["Hyper Window Tiling: Move Up", "Meta+Ctrl+Alt+Shift+W"],
  "move-left": ["Hyper Window Tiling: Move Left", "Meta+Ctrl+Alt+Shift+A"],
  "move-down": ["Hyper Window Tiling: Move Down", "Meta+Ctrl+Alt+Shift+S"],
  "move-right": ["Hyper Window Tiling: Move Right", "Meta+Ctrl+Alt+Shift+D"],
  "move-max-almost": [
    "Hyper Window Tiling: Almost Maximize or Center",
    "Meta+Ctrl+Alt+Shift+Return",
  ],
} as const satisfies Record<CycleBindingName, readonly [string, string]>;

const MAXIMIZE_SHORTCUT = [
  "Hyper Window Tiling: Maximize",
  "Meta+Ctrl+Alt+Shift+\\",
] as const satisfies readonly [string, string];

export function registerTilingShortcuts(handlers: ShortcutHandlers) {
  for (const bindingName of CYCLE_BINDING_NAMES) {
    const [title, shortcut] = CYCLE_SHORTCUTS[bindingName];
    registerTilingShortcut(bindingName, title, shortcut, () =>
      handlers.applyCycle(bindingName),
    );
  }

  const [title, shortcut] = MAXIMIZE_SHORTCUT;
  registerTilingShortcut(
    MAXIMIZE_BINDING_NAME,
    title,
    shortcut,
    handlers.maximizeFocusedWindow,
  );
}

function registerTilingShortcut(
  bindingName: BindingName,
  title: string,
  shortcut: string,
  handler: () => void,
) {
  registerShortcut(`hyper-window-tiling-${bindingName}`, title, shortcut, handler);
}
