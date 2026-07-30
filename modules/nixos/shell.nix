{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.modules) mkIf;
  inherit (lib.options) mkEnableOption;
in
{
  _class = "nixos";

  options.local.shell.enable = mkEnableOption "NixOS shell package and login-shell support for the existing dotfiles";

  config = mkIf config.local.shell.enable {
    programs = {
      bash = {
        enable = true;
        promptInit = "";
      };

      zsh = {
        enable = true;
        enableGlobalCompInit = false;
        promptInit = "";
      };
    };

    users.users.${config.local.user.name}.shell = pkgs.zsh;

    environment.systemPackages = with pkgs; [
      atuin
      bash-completion
      btop
      curl
      eza
      fastfetch
      fzf
      nmap
      starship
      yazi
      zoxide
    ];
  };
}
