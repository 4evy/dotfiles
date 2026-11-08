{ inputs, lib }:
let
  palette = (lib.trivial.importJSON ../../../theme/palette/palette.json).catppuccin_custom;
  quickCss = import ./theme.nix {
    inherit lib palette;
    exceptions = lib.trivial.readFile ./css/css.css;
  };
  settings =
    (import ./settings.nix {
      inherit lib;
      parseRules = lib.trivial.importJSON "${inputs.nixcord}/modules/plugins/parse-rules.json";
    })
    // {
      inherit quickCss;
    };
in
{
  inherit quickCss settings;
}
