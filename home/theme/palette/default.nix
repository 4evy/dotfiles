{
  inputs,
  lib,
  system,
}:
let
  # Use the module's pinned source directly, without building a theme package
  upstream = lib.trivial.importJSON "${
    inputs.catppuccin.packages.${system}.palette.src
  }/palette.json";
  definitions = lib.trivial.importJSON ./roles.json;
  custom = (lib.trivial.importJSON ./palette.json).catppuccin_custom;
  palette = lib.attrsets.mapAttrs (
    mode: definition:
    lib.attrsets.mapAttrs (
      role: reference:
      if lib.strings.hasPrefix "token:" reference then
        upstream.${definition.flavor}.colors.${lib.strings.removePrefix "token:" reference}.hex
      else
        custom.${mode}.${role}
    ) (definitions.common // definition.roles)
  ) definitions.modes;

  # tty consumes only .colors.<name>.hex, not the full upstream color metadata
  # Override named colors, never semantic fills such as accentPink/accentBlue
  ttyPalette = lib.attrsets.mapAttrs (
    flavor: data:
    let
      mode = lib.lists.findFirst (mode: definitions.modes.${mode}.flavor == flavor) null [
        "light"
        "dark"
      ];
    in
    {
      colors = lib.attrsets.mapAttrs (name: color: {
        hex = if mode == null then color.hex else palette.${mode}.${name};
      }) data.colors;
    }
  ) (builtins.removeAttrs upstream [ "version" ]);
in
assert lib.asserts.assertMsg (upstream.version == custom._source.version)
  "Catppuccin palette changed: update @catppuccin/palette and run bun home/theme/palette/generate.ts";
{
  inherit palette ttyPalette;
}
