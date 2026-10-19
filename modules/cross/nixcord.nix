{ dotfilesEquicordSettings, ... }:
{
  _class = null;

  programs.nixcord = {
    enable = true;
    discord = {
      vencord.enable = false;
      equicord.enable = true;
      krisp.enable = true;
    };
    inherit (dotfilesEquicordSettings) quickCss;
  };
  programs.nixcord.config = dotfilesEquicordSettings.nixcordConfig;
}
