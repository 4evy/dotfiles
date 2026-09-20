{
  config,
  lib,
  ...
}:
let
  inherit (lib.options) mkOption;
  inherit (lib.types) nonEmptyStr;

  cfg = config.local.user;
  # Keep invalid user names evaluable long enough for the assertion below to
  # report the actual configuration error instead of failing at attr lookup.
  user =
    config.users.users.${cfg.name} or {
      home = "/home/${cfg.name}";
      group = "users";
    };
in
{
  imports = [
    ../cross
    ./desktop-packages.nix
    ./gnome.nix
    ./hardware.nix
    ./kanata.nix
    ./kde.nix
    ./networking.nix
    ./packages.nix
    ./shell.nix
    ./toshy.nix
    ./vicinae.nix
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
