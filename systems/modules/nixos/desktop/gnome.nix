{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.attrsets) attrValues;
  inherit (lib.modules) mkIf mkMerge;
  inherit (lib.options) mkEnableOption;
  inherit (lib.gvariant) mkInt32;
  sharedDefaults = import ../../../../nix/lib/gnome/defaults.nix { inherit lib; };
  inherit (pkgs) gnomeExtensions hyper-window-tiling-gnome;
  inherit (gnomeExtensions)
    appindicator
    copyous
    focused-window-d-bus
    pip-on-top
    ;

  copyousExtension = copyous;
  copyousExtensionUuid = copyousExtension.extensionUuid;
  toshyWindowContextExtension = focused-window-d-bus;
  toshyWindowContextExtensionUuid = toshyWindowContextExtension.extensionUuid;
  hyperWindowTilingExtension = hyper-window-tiling-gnome;
  hyperWindowTilingExtensionUuid = hyperWindowTilingExtension.passthru.extensionUuid;

in
{
  options.local.gnome.enable = mkEnableOption "GNOME";
  options.local.dconf.enable = mkEnableOption "Dconf";

  config = mkMerge [
    (mkIf config.local.gnome.enable {
      services = {
        displayManager.gdm.enable = true;
        desktopManager.gnome.enable = true;
      };
      environment.systemPackages = attrValues {
        inherit copyousExtension;
        inherit toshyWindowContextExtension;
        inherit (pkgs)
          apostrophe # Markdown Editor
          decibels # Audio Player
          gnome-obfuscate # Censor Private Info
          loupe # Image Viewer
          mousai # Shazam-like
          papers # PDF Viewer
          resources # Task Manager
          showtime # Video Player
          ;
      };
      environment.gnome.excludePackages = attrValues {
        inherit (pkgs)
          gnome-maps
          gnome-music
          gnome-tour
          gnome-weather
          epiphany # Browser
          geary # Email
          evince # Docs
          totem # Videos
          ;
      };
    })
    (mkIf config.local.dconf.enable {
      environment.systemPackages = attrValues {
        inherit appindicator pip-on-top;
        inherit hyperWindowTilingExtension;
      };
      programs.dconf.profiles.user.databases = [
        {
          lockAll = true; # Prevents overriding
          settings = sharedDefaults // {
            "org/gnome/desktop/interface" = sharedDefaults."org/gnome/desktop/interface" // {
              gtk-enable-primary-paste = false;
              enable-animations = false;
              clock-show-date = true;
              clock-show-seconds = true;
              clock-format = "24h";
            };

            "org/gnome/desktop/wm/preferences" = {
              num-workspaces = mkInt32 9;
              button-layout = "close,minimize,maximize:";
              resize-with-right-button = true;
            };

            "org/gnome/shell/app-switcher" = {
              current-workspace-only = false;
            };

            "org/gnome/settings-daemon/plugins/media-keys" = {
              custom-keybindings = [
                "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/vicinae/"
              ];
            };

            "org/gnome/shell" = {
              enabled-extensions = [
                appindicator.extensionUuid
                copyousExtensionUuid
                hyperWindowTilingExtensionUuid
                "workspaces@farstep.local"
                pip-on-top.extensionUuid
                toshyWindowContextExtensionUuid
              ];
            };

          };
        }
      ];
    })
  ];
}
