{ dotfilesEquicordSettings, ... }:
let
  discordQuickCss = builtins.readFile ../../../packages/equicord/quickCss.css;
in
{
  programs.nixcord = {
    enable = true;
    discord.vencord.enable = false;
    discord.equicord.enable = true;
    discord.krisp.enable = true;
    quickCss = discordQuickCss;
  };
  programs.nixcord.config = dotfilesEquicordSettings.nixcordConfig;
}
