{
  config,
  lib,
  ...
}:
let
  inherit (lib.options) mkOption;
  inherit (lib.types) nonEmptyStr passwdEntry path;

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
  _class = "nixos";

  meta.maintainers = [ lib.maintainers._4evy ];

  imports = [
    ./nix.nix
    ../shared/nixpkgs.nix
    ./desktop/packages.nix
    ./desktop/gnome.nix
    ./hardware.nix
    ./input/kanata.nix
    ./desktop/kde.nix
    ./networking.nix
    ./packages.nix
    ./shell.nix
    ./input/toshy.nix
    ./vicinae.nix
    ../shared/nixcord.nix
    ./services.nix
    ./zed/zed.nix
  ];

  options.local.user = {
    name = mkOption {
      type = passwdEntry nonEmptyStr;
      description = "Primary interactive user managed by the dotfiles NixOS modules.";
    };

    home = mkOption {
      type = passwdEntry path;
      readOnly = true;
      default = user.home;
      defaultText = lib.literalExpression "config.users.users.\${config.local.user.name}.home";
      apply = toString;
      description = "Home directory of the primary interactive user.";
    };

    group = mkOption {
      type = passwdEntry nonEmptyStr;
      readOnly = true;
      default = user.group;
      defaultText = lib.literalExpression "config.users.users.\${config.local.user.name}.group";
      description = "Primary group of the primary interactive user.";
    };
  };

  config = {
    assertions = [
      {
        assertion = lib.hasAttr cfg.name config.users.users;
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
