{
  formats,
  inputs,
  lib,
  linkFarm,
  writeText,
  dotfilesPackageUpdaters,
}:
let
  inherit (import ./. { inherit inputs lib; }) quickCss settings;
  quickCssFile = writeText "equicord-quick-css" quickCss;
  settingsFile = (formats.json { }).generate "equicord-settings.json" settings.jsonConfig;
in
# Bundle the sources for the standalone Hjem deployment
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
      platforms = lib.systems.doubles.all;
    };
    strictDeps = true;
    passthru.updateScript = dotfilesPackageUpdaters.flakeInputs [ "nixcord" ];
  }
