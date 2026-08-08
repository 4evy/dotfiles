{
  config,
  lib,
  ...
}:
let
  inherit (lib.options) mkOption;
  inherit (lib.types) nonEmptyStr;

  cfg = config.local.user;
  user = config.users.users.${cfg.name};
in
{
  imports = [
    ../cross
    ./desktop-packages.nix
    ./gnome.nix
    ./ghidra-mcp.nix
    ./hardware.nix
    ./kanata.nix
    ./kde.nix
    ./networking.nix
    ./packages.nix
    ./shell.nix
    ./nixcord/settings.nix
    ./services.nix
    ./zed-remote.nix
  ];

  options.local.user = {
    name = mkOption {
      type = nonEmptyStr;
      description = "Primary interactive user managed by the dotfiles NixOS modules.";
    };

    home = mkOption {
      type = nonEmptyStr;
      readOnly = true;
      default = user.home;
      description = "Home directory of the primary interactive user.";
    };

    group = mkOption {
      type = nonEmptyStr;
      readOnly = true;
      default = user.group;
      description = "Primary group of the primary interactive user.";
    };
  };

  config = {
    assertions = [
      {
        assertion = builtins.hasAttr cfg.name config.users.users;
        message = "local.user.name must identify an account declared in users.users.";
      }
      {
        assertion = !(config.local.gnome.enable && config.local.kde.enable);
        message = "local.gnome.enable and local.kde.enable cannot both be enabled.";
      }
    ];

    determinate.enable = true;
    nix.optimise = {
      automatic = true;
      dates = [ "weekly" ];
    };
    programs.nixcord.user = config.local.user.name;
  };
}
