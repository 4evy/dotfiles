{
  dotfilesEquicordSettings,
  lib,
  pkgs,
  ...
}:
{
  _class = null;

  programs.nixcord = {
    enable = true;
    discord = {
      vencord.enable = false;
      equicord.enable = true;
      krisp.enable = true;
      commandLineArgs = lib.optionals pkgs.stdenv.hostPlatform.isLinux (
        lib.importJSON ../../../home/applications/discord/flags.json
      );
    };
    inherit (dotfilesEquicordSettings) quickCss;
  };
  programs.nixcord.config = dotfilesEquicordSettings.nixcordConfig;
}
