{
  formats,
  lib,
  linkFarm,
  quickCss,
  settings,
  writeText,
}:
let
  quickCssFile = writeText "equicord-quick-css" quickCss;
  settingsFile = (formats.json { }).generate "equicord-settings.json" settings;
in
# Share immutable JSON/CSS store files with the byte-reading deployer
(linkFarm "equicord-settings" {
  "settings.json" = settingsFile;
  "quickCss.css" = quickCssFile;
}).overrideAttrs
  {
    meta = {
      description = "Equicord settings shared by NixOS and non-NixOS installations";
      homepage = "https://github.com/4evy/dotfiles";
      license = lib.licenses.mit;
      maintainers = [ lib.maintainers._4evy ];
      platforms = lib.platforms.all;
    };
    strictDeps = true;
  }
