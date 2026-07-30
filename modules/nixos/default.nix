{
  config,
  inputs,
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
    inputs.browser.nixosModules.default
    inputs.determinate.nixosModules.default
    ./desktop-packages.nix
    ./gnome.nix
    ./ghidra-mcp.nix
    ./hardware.nix
    ./kanata.nix
    ./kde.nix
    ./networking.nix
    ./packages.nix
    ./shell.nix
    inputs.nixcord.nixosModules.nixcord
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
    ];

    determinate.enable = true;
    nix.optimise = {
      automatic = true;
      dates = [ "weekly" ];
    };
    programs.nixcord.user = config.local.user.name;
  };
}
