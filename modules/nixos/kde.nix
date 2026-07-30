{
  config,
  dotfilesPackages,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.attrsets) attrValues;
  inherit (lib.modules) mkIf mkMerge;
  inherit (lib.options) mkEnableOption;
in
{
  options.local.kde.enable = mkEnableOption "KDE Plasma";
  options.local.kde.hyperWindowTiling.enable = mkEnableOption "Hyper-key KWin window tiling script";

  config = mkMerge [
    (mkIf config.local.kde.enable {
      services = {
        displayManager.sddm.enable = true;
        desktopManager.plasma6.enable = true;
      };
      environment.systemPackages = attrValues {
        inherit (pkgs.unstable.kdePackages)
          breeze
          breeze-gtk
          breeze-icons
          ffmpegthumbs
          ;
      };
    })
    (mkIf (config.local.kde.enable || config.local.kde.hyperWindowTiling.enable) {
      environment.systemPackages = [
        dotfilesPackages.hyper-window-tiling-kde
      ];
    })
  ];
}
