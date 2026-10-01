{
  formats,
  lib,
  quickCss,
  runCommand,
  settings,
  writeText,
}:
let
  quickCssFile = writeText "equicord-quick-css" quickCss;
  settingsFile = (formats.json { }).generate "equicord-settings.json" settings;
in
runCommand "equicord-settings"
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
  ''
    mkdir -p "$out"
    cp ${settingsFile} "$out/settings.json"
    cp ${quickCssFile} "$out/quickCss.css"
  ''
