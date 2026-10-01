{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.attrsets) attrValues;
  inherit (lib.modules) mkIf;
  inherit (lib.strings) concatStringsSep;
  inherit (lib) getExe;

  desktopEnabled = config.local.gnome.enable || config.local.kde.enable;
  chromiumFeatures = [
    "ForceEnableWebGpuInterop"
    "ReduceOpsTaskSplitting"
    "TouchpadOverscrollHistoryNavigation"
    "VaapiVideoDecoder"
    "VaapiVideoEncoder"
    "BrowsingTopics"
    "InterestGroupStorage"
  ];

  chromiumDisabledFeatures = [
    "ExtensionManifestV2Unsupported"
    "ExtensionManifestV2Disabled"
  ];

  commandLineArgs = [
    "--enable-logging=stderr"
    "--enable-features=${concatStringsSep "," chromiumFeatures}"
    "--disable-features=${concatStringsSep "," chromiumDisabledFeatures}"
    "--omnibox-autocomplete-filtering=search"
    "--set-color-scheme=dark"
    "--set-color-variant=tonal_spot"
    "--ignore-gpu-blocklist"
    "--enable-wayland-ime"
    "--wayland-text-input-version=3"
  ];

  heliumConfigSource = lib.importTOML ../../browser/helium.toml;
  heliumConfig = lib.recursiveUpdate heliumConfigSource {
    browser.linux = {
      app_dir = toString heliumAppDir;
      wrapper_flags = commandLineArgs;
    };
    extension_settings.files = map (
      path: pkgs.writeText "helium-${baseNameOf path}" (builtins.readFile (../../browser + "/${path}"))
    ) heliumConfigSource.extension_settings.files;
  };

  heliumBrowser = pkgs.eupkgs.helium-browser;
  heliumAppDir = pkgs.linkFarm "helium-browser-app" {
    "helium-wrapper" = getExe heliumBrowser;
    "helium.desktop" = "${heliumBrowser}/share/applications/helium.desktop";
    "product_logo_256.png" = "${heliumBrowser}/share/icons/hicolor/256x256/apps/helium.png";
  };

  applyHelium = pkgs.writeShellApplication {
    name = "apply-helium";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
      pkgs.gh
      pkgs.jq
    ];
    text = ''
      config_home="''${XDG_CONFIG_HOME:-$HOME/.config}"
      profile_dir="$config_home/net.imput.helium/Default"

      curl -fsSL 'https://github.com/4evy.png?size=256' |
        install -Dm0644 /dev/stdin \
        "$profile_dir/Custom Avatar Picture.png"

      token="$(gh auth token 2>/dev/null || true)"
      if [ -n "$token" ]; then
        export GITHUB_TOKEN="$token"
      fi
      input="$(jq -nc --arg token "$token" \
        '{extension_values: (if $token == "" then {} else {"refined-github-personal-token": $token} end)}')"

      printf '%s' "$input" | ${getExe config.programs.browser.package} apply \
        '${config.programs.browser.configFile}' \
        --input -
    '';
  };
in
{
  config = mkIf desktopEnabled {
    programs.chromium.enable = true;
    programs.browser = {
      enable = true;
      settings = heliumConfig;
    };

    environment.systemPackages = attrValues {
      inherit heliumBrowser;

      inherit (pkgs.unstable)
        networkmanagerapplet
        pavucontrol
        playerctl
        telegram-desktop
        ;
    };

    systemd.user.services.apply-helium = {
      description = "Apply the declarative Helium browser configuration";
      after = [ "graphical-session.target" ];
      partOf = [ "graphical-session.target" ];
      unitConfig.ConditionUser = config.local.user.name;
      serviceConfig = {
        Type = "oneshot";
        ExecStart = getExe applyHelium;
      };
    };

    systemd.user.timers.apply-helium = {
      description = "Apply Helium after the graphical session starts";
      wantedBy = [ "graphical-session.target" ];
      partOf = [ "graphical-session.target" ];
      timerConfig = {
        OnActiveSec = "1s";
        Unit = "apply-helium.service";
      };
    };
  };
}
