import type { BindingName, LayoutPreset } from "@dotfiles/tiling/shared";
import { BINDING_NAMES, BINDINGS } from "@dotfiles/tiling/shared";

export type ShortcutHandlers = {
  applyCycle: (bindingName: BindingName, presets: readonly LayoutPreset[]) => void;
  maximizeFocusedWindow: () => void;
};

export function registerTilingShortcuts(handlers: ShortcutHandlers) {
  for (const bindingName of BINDING_NAMES) {
    const binding = BINDINGS[bindingName];
    registerShortcut(
      `hyper-window-tiling-${bindingName}`,
      binding.kde.title,
      binding.kde.accelerator,
      binding.action === "cycle"
        ? () => handlers.applyCycle(bindingName, binding.presets)
        : handlers.maximizeFocusedWindow,
    );
  }
}
