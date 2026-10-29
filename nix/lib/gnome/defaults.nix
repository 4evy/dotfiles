{ lib }:
let
  inherit (lib.gvariant) mkEmptyArray type;
  workspaceNumbers = map toString (lib.range 1 9);
  workspaceBindings =
    prefix: modifiers:
    lib.genAttrs' workspaceNumbers (
      number: lib.nameValuePair "${prefix}-${number}" [ "<Super>${modifiers}${number}" ]
    );
  bindings = lib.importJSON ../../../tools/tiling/bindings.json;
in
{
  "org/gnome/desktop/interface" = {
    font-name = "Noto Sans 11";
    document-font-name = "Noto Sans 12";
    monospace-font-name = "JetBrainsMono Nerd Font Mono 11";
  };
  "org/gnome/desktop/wm/keybindings" = {
    switch-to-workspace-left = mkEmptyArray type.string;
    switch-to-workspace-right = mkEmptyArray type.string;
    move-to-workspace-left = mkEmptyArray type.string;
    move-to-workspace-right = mkEmptyArray type.string;
    switch-applications = mkEmptyArray type.string;
    switch-applications-backward = mkEmptyArray type.string;
    switch-windows = [
      "<Alt>Tab"
      "<Super>Tab"
    ];
    switch-windows-backward = [
      "<Shift><Alt>Tab"
      "<Shift><Super>Tab"
    ];
  }
  // workspaceBindings "switch-to-workspace" ""
  // workspaceBindings "move-to-workspace" "<Shift>";
  # Workspace shortcuts must not also activate GNOME's application shortcuts
  "org/gnome/shell/keybindings" = lib.genAttrs (map (
    number: "switch-to-application-${number}"
  ) workspaceNumbers) (_: mkEmptyArray type.string);
  "org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/vicinae" = {
    name = "Vicinae";
    command = "vicinae toggle";
    binding = "<Super><Control><Alt><Shift>F24";
  };
  "org/gnome/shell/extensions/hyper-window-tiling" = lib.mapAttrs (_: binding: [
    binding.gnome.accelerator
  ]) bindings;
  "org/gnome/shell/extensions/blur-my-shell/popup".blur = false;
  "org/gnome/shell/extensions/vicinae" = {
    enable-clipboard-monitoring = true;
    blocked-applications = [ "1Password" ];
  };
}
