{
  config,
  pkgs,
  lib,
  ...
}:
let
  inherit (lib.modules) mkIf;
  inherit (lib.options) mkEnableOption;

  cfg = config.local.toshy;
  user = config.local.user.name;
in
{
  options.local.toshy.enable = mkEnableOption "Toshy keyboard remapping";

  config = mkIf cfg.enable {
    # The imported upstream module owns only the system layer: uinput, udev
    # access, and input-group membership.
    services.toshy = {
      enable = true;
      users = [ user ];
    };

    # Upstream delegates this link to Home Manager. This repository does not
    # otherwise use Home Manager, so keep the same runtime seam with NixOS's
    # per-user tmpfiles support instead of adding another module framework.
    systemd.user.tmpfiles.users.${user}.rules = [
      "d %S/toshy 0700 - - -"
      "L+ %S/toshy/runtime - - - - ${pkgs.toshy-runtime}"
    ];
  };
}
