{ dotfilesEquicordSettings, ... }:
{
  programs.nixcord = {
    enable = true;
    discord.vencord.enable = false;
    discord.equicord.enable = true;
    discord.krisp.enable = true;
    quickCss = dotfilesEquicordSettings.quickCss;
  };
  programs.nixcord.config = dotfilesEquicordSettings.nixcordConfig;
}
