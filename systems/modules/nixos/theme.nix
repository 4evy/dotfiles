{
  inputs,
  lib,
  pkgs,
  ...
}:
let
  theme = import ../../../home/theme/palette {
    inherit inputs lib;
    inherit (pkgs.stdenv.hostPlatform) system;
  };
in
{
  # Keep application templates, mode switching, icons, and cursors under Hjem
  # Auto-enrollment would replace those customizations with stock ports
  catppuccin = {
    enable = true;
    autoEnable = false;
    flavor = "mocha";
    accent = "pink";
    tty.enable = true;
    sources.palette = pkgs.writeTextDir "palette.json" (builtins.toJSON theme.ttyPalette);
  };
}
