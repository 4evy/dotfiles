{ inputs, lib, ... }:
let
  discordQuickCss = builtins.readFile ../../../packages/equicord/quickCss.css;
  equicordSettings = import ../../equicord/settings.nix {
    inherit lib;
    parseRules = builtins.fromJSON (
      builtins.readFile "${inputs.nixcord}/modules/plugins/parse-rules.json"
    );
  };
in
{
  programs.nixcord = {
    enable = true;
    discord.vencord.enable = false;
    discord.equicord.enable = true;
    discord.krisp.enable = true;
    quickCss = discordQuickCss;
  };
  programs.nixcord.config = equicordSettings.nixcordConfig;
}
