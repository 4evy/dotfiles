{
  config,
  dotfilesPackages,
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
  inherit (lib.meta) getExe';
  inherit (lib.modules) mkIf mkMerge;
  inherit (lib.options) mkEnableOption;
  inherit (lib.gvariant)
    mkBoolean
    mkInt32
    mkString
    mkArray
    mkEmptyArray
    type
    ;

  workspaceNumbers = map toString (lib.lists.range 1 9);

  generateKeybindings =
    prefix: super: modifiers:
    let
      modifierStr = lib.strings.concatStrings modifiers;
    in
    genAttrs' workspaceNumbers (
      num: nameValuePair "${prefix}-${num}" (mkArray [ "${super}${modifierStr}${num}" ])
    );

  sleepTargets = [
    "systemd-suspend.service"
    "systemd-hibernate.service"
  ];

  copyousExtension = pkgs.gnomeExtensions.copyous;
  copyousExtensionUuid = copyousExtension.extensionUuid;
  hyperWindowTilingExtension = dotfilesPackages.hyper-window-tiling-gnome;
  hyperWindowTilingExtensionUuid = hyperWindowTilingExtension.passthru.extensionUuid;

  gnomeShell = getExe' pkgs.gnome-shell "gnome-shell";
  pkill = getExe' pkgs.procps "pkill";
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
    # Fix for GNOME suspend/resume issues with NVIDIA GPUs
    (mkIf config.local.nvidia.enable {
      systemd.services = {
        gnome-suspend = {
          description = "Suspend gnome shell";
          before = sleepTargets ++ [
            "nvidia-suspend.service"
            "nvidia-hibernate.service"
          ];
          wantedBy = sleepTargets;
          serviceConfig = {
            Type = "oneshot";
            ExecStart = "${pkill} -f -STOP ${gnomeShell}";
          };
        };
        gnome-resume = {
          description = "Resume gnome shell";
          after = sleepTargets ++ [
            "nvidia-resume.service"
          ];
          wantedBy = sleepTargets;
          serviceConfig = {
            Type = "oneshot";
            ExecStart = "${pkill} -f -CONT ${gnomeShell}";
          };
        };
      };
    })
    (mkIf config.local.dconf.enable {
      environment.systemPackages = attrValues {
        inherit (pkgs.gnomeExtensions) appindicator clipboard-indicator pip-on-top;
        inherit hyperWindowTilingExtension;
      };
      programs.dconf.profiles.user.databases = [
        {
          lockAll = true; # Prevents overriding
          settings = {
            "org/gnome/desktop/interface" = {
              gtk-enable-primary-paste = mkBoolean false;
              enable-animations = mkBoolean false;
              clock-show-date = mkBoolean true;
              clock-show-seconds = mkBoolean true;
              clock-format = mkString "24h";
            };

            "org/gnome/desktop/wm/preferences" = {
              num-workspaces = mkInt32 9;
              button-layout = mkString "close,minimize,maximize:";
              resize-with-right-button = mkBoolean true;
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
              switch-applications = mkEmptyArray type.string;
              switch-applications-backward = mkEmptyArray type.string;
              switch-windows = mkArray [
                "<Alt>Tab"
                "<Super>Tab"
              ];
              switch-windows-backward = mkArray [
                "<Shift><Alt>Tab"
                "<Shift><Super>Tab"
              ];
            }
            // generateKeybindings "switch-to-workspace" "<Super>" [ ]
            // generateKeybindings "move-to-workspace" "<Super>" [ "<Shift>" ];

            "org/gnome/shell/app-switcher" = {
              current-workspace-only = mkBoolean false;
            };

            "org/gnome/shell" = {
              enabled-extensions = mkArray [
                "appindicatorsupport@rgcjonas.gmail.com"
                "clipboard-indicator@tudmotu.com"
                copyousExtensionUuid
                hyperWindowTilingExtensionUuid
                "pip-on-top@rafostar.github.com"
              ];
            };

            "org/gnome/shell/extensions/hyper-window-tiling" = {
              move-up = mkArray [ "<Super><Control><Alt><Shift>w" ];
              move-left = mkArray [ "<Super><Control><Alt><Shift>a" ];
              move-down = mkArray [ "<Super><Control><Alt><Shift>s" ];
              move-right = mkArray [ "<Super><Control><Alt><Shift>d" ];
              move-max-almost = mkArray [ "<Super><Control><Alt><Shift>Return" ];
              move-max = mkArray [ "<Super><Control><Alt><Shift>backslash" ];
            };
          };
        }
      ];
    })
  ];
}
