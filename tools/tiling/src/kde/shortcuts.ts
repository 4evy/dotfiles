import type { BindingName, LayoutPreset } from "@dotfiles/tiling/shared";
import { BINDING_NAMES, BINDINGS } from "@dotfiles/tiling/shared";

type ShortcutHandlers = {
  applyCycle: (bindingName: BindingName, presets: readonly LayoutPreset[]) => void;
  maximizeFocusedWindow: () => void;
};

export function registerTilingShortcuts(handlers: ShortcutHandlers) {
  for (const bindingName of BINDING_NAMES) {
    const binding = BINDINGS[bindingName];
    registerTilingShortcut(
      bindingName,
      binding.kde.title,
      binding.kde.accelerator,
      binding.action === "cycle"
        ? () => handlers.applyCycle(bindingName, binding.presets)
        : handlers.maximizeFocusedWindow,
    );
  }
}

function registerTilingShortcut(
  bindingName: BindingName,
  title: string,
  shortcut: string,
  handler: () => void,
) {
  registerShortcut(`hyper-window-tiling-${bindingName}`, title, shortcut, handler);
}
