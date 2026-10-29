{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.attrsets)
    attrValues
    genAttrs
    genAttrs'
    nameValuePair
    ;
  inherit (lib.modules) mkIf mkMerge;
  inherit (lib.options) mkEnableOption;
  # Integer width and empty-array element types still need explicit GVariants
  inherit (lib.gvariant)
    mkInt32
    mkEmptyArray
    type
    ;
  inherit (pkgs) gnomeExtensions hyper-window-tiling-gnome;
  inherit (gnomeExtensions)
    appindicator
    copyous
    focused-window-d-bus
    pip-on-top
    ;

  workspaceNumbers = map toString (lib.lists.range 1 9);

  generateKeybindings =
    prefix: super: modifiers:
    let
      modifierStr = lib.strings.concatStrings modifiers;
    in
    genAttrs' workspaceNumbers (
      num: nameValuePair "${prefix}-${num}" [ "${super}${modifierStr}${num}" ]
    );

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
          settings = {
            "org/gnome/desktop/interface" = {
              gtk-enable-primary-paste = false;
              enable-animations = false;
              clock-show-date = true;
              clock-show-seconds = true;
              clock-format = "24h";
              font-name = "Noto Sans 11";
              document-font-name = "Noto Sans 12";
              monospace-font-name = "JetBrainsMono Nerd Font Mono 11";
            };

            "org/gnome/desktop/wm/preferences" = {
              num-workspaces = mkInt32 9;
              button-layout = "close,minimize,maximize:";
              resize-with-right-button = true;
            };

            /*
              For some reason, `switch-to-workplace` will also assign
              `switch-to-application`, which we do not want as it breaks
              everything, so we have to explicitly set it to nothing
            */
            "org/gnome/shell/keybindings" = genAttrs (map (n: "switch-to-application-${n}") workspaceNumbers) (
              _: mkEmptyArray type.string
            );

            "org/gnome/desktop/wm/keybindings" = {
              switch-to-workspace-left = mkEmptyArray type.string;
              switch-to-workspace-right = mkEmptyArray type.string;
              move-to-workspace-left = mkEmptyArray type.string;
              move-to-workspace-right = mkEmptyArray type.string;
              switch-applications = mkEmptyArray type.string;
              switch-applications-backward = mkEmptyArray type.string;
              switch-windows = [
                "<Alt>Tab"
                "<Super>Tab"
              ];
              switch-windows-backward = [
                "<Shift><Alt>Tab"
                "<Shift><Super>Tab"
              ];
            }
            // generateKeybindings "switch-to-workspace" "<Super>" [ ]
            // generateKeybindings "move-to-workspace" "<Super>" [ "<Shift>" ];

            "org/gnome/shell/app-switcher" = {
              current-workspace-only = false;
            };

            "org/gnome/settings-daemon/plugins/media-keys" = {
              custom-keybindings = [
                "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/vicinae/"
              ];
            };

            "org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/vicinae" = {
              name = "Vicinae";
              command = "vicinae toggle";
              binding = "<Super><Control><Alt><Shift>F24";
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

            "org/gnome/shell/extensions/hyper-window-tiling" = {
              move-up = [ "<Super><Control><Alt><Shift>w" ];
              move-left = [ "<Super><Control><Alt><Shift>a" ];
              move-down = [ "<Super><Control><Alt><Shift>s" ];
              move-right = [ "<Super><Control><Alt><Shift>d" ];
              move-max-almost = [ "<Super><Control><Alt><Shift>Return" ];
              move-max = [ "<Super><Control><Alt><Shift>backslash" ];
            };
            "org/gnome/shell/extensions/blur-my-shell/popup".blur = false;
            "org/gnome/shell/extensions/vicinae" = {
              enable-clipboard-monitoring = true;
              blocked-applications = [ "1Password" ];
            };
          };
        }
      ];
    })
  ];
}
