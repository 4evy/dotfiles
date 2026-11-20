{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (pkgs)
    linkFarm
    unstable
    writeShellApplication
    ;
  inherit (pkgs.eupkgs) helium-browser;

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
    "--enable-features=${lib.strings.concatStringsSep "," chromiumFeatures}"
    "--disable-features=${lib.strings.concatStringsSep "," chromiumDisabledFeatures}"
    "--omnibox-autocomplete-filtering=search"
    "--set-color-scheme=dark"
    "--set-color-variant=tonal_spot"
    "--ignore-gpu-blocklist"
    "--enable-wayland-ime"
    "--wayland-text-input-version=3"
  ];

  heliumConfigSource = lib.trivial.importTOML ../../../../home/applications/helium/config.toml;
  heliumConfig = lib.attrsets.recursiveUpdate heliumConfigSource {
    browser.linux = {
      app_dir = toString heliumAppDir;
      wrapper_flags = commandLineArgs;
    };
    extension_settings.files = lib.lists.map (
      path: "${../../../../home/applications/helium + "/${path}"}"
    ) heliumConfigSource.extension_settings.files;
  };

  heliumBrowser = helium-browser;
  heliumAppDir =
    (linkFarm "helium-browser-app" {
      "helium-wrapper" = lib.meta.getExe heliumBrowser;
      "helium.desktop" = "${heliumBrowser}/share/applications/helium.desktop";
      "product_logo_256.png" = "${heliumBrowser}/share/icons/hicolor/256x256/apps/helium.png";
    }).overrideAttrs
      {
        passthru.updateScript = pkgs.dotfilesPackageUpdaters.flakeInputs [ "eupkgs" ];
      };

  applyHelium = writeShellApplication {
    name = "apply-helium";
    meta.mainProgram = "apply-helium";
    passthru.updateScript = pkgs.dotfilesPackageUpdaters.flakeInputs [
      "eupkgs"
      "tweezle"
    ];
    runtimeInputs = lib.attrsets.attrValues {
      inherit (pkgs)
        coreutils
        curl
        gh
        jq
        ;
    };
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

      printf '%s' "$input" | ${lib.meta.getExe config.programs.tweezle.package} apply \
        '${config.programs.tweezle.configFile}' \
        --input -
    '';
  };
in
{
  config = lib.modules.mkIf desktopEnabled {
    programs.chromium.enable = true;
    programs.tweezle = {
      enable = true;
      activate = false;
      settings.chromium = heliumConfig.browser // lib.attrsets.removeAttrs heliumConfig [ "browser" ];
    };

    environment.systemPackages = lib.attrsets.attrValues {
      inherit heliumBrowser;

      inherit (unstable)
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
        ExecStart = lib.meta.getExe applyHelium;
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
