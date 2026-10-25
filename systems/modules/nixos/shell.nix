{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.attrsets) attrValues;
  inherit (pkgs) zsh;
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

    users.users.${config.local.user.name}.shell = zsh;

    # Hjem and the browser reconciler install user-owned commands here
    environment.localBinInPath = true;

    environment.systemPackages = attrValues {
      inherit (pkgs)
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
        ;
    };
  };
}
