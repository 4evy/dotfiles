{
  config,
  inputs,
  lib,
  ...
}:
let
  theme = import ../../../home/theme/palette {
    inherit inputs lib;
  };
  palette = theme.ttyPalette.${config.catppuccin.flavor}.colors;
in
{
  # Keep application templates, mode switching, icons, and cursors under Hjem
  # Auto-enrollment would replace those customizations with stock ports
  catppuccin = {
    enable = true;
    autoEnable = false;
    flavor = "mocha";
    accent = "pink";
  };

  # Set the same ANSI slots as Catppuccin's TTY module without importing a build
  console.colors = lib.modules.mkIf (config.catppuccin.enable && config.console.enable) (
    map (name: lib.strings.removePrefix "#" palette.${name}.hex) [
      "base"
      "red"
      "green"
      "yellow"
      "blue"
      "pink"
      "teal"
      "subtext1"
      "surface2"
      "red"
      "green"
      "yellow"
      "blue"
      "pink"
      "teal"
      "subtext0"
    ]
  );
}
