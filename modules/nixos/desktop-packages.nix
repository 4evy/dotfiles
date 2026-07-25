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
  heliumProfileDir = "/home/4evy/.config/net.imput.helium/Default";

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
    "--set-user-color=244,184,228"
    "--set-color-scheme=dark"
    "--set-color-variant=tonal_spot"
    "--ignore-gpu-blocklist"
    "--enable-wayland-ime"
    "--wayland-text-input-version=3"
  ];

  heliumConfigSource = builtins.fromTOML (builtins.readFile ../../browser/helium.toml);
  heliumConfig = heliumConfigSource // {
    extension_settings = heliumConfigSource.extension_settings // {
      files = map (path: ../../browser + "/${path}") heliumConfigSource.extension_settings.files;
    };
  };
  extensionCatalog = heliumConfig.extensions;

  externalExtensionFile = id: value: {
    name = "xdg/net.imput.helium/External Extensions/${id}.json";
    value.text = builtins.toJSON value;
  };

  chromeStoreExternalExtensionFile =
    extension:
    externalExtensionFile extension.id {
      external_update_url = extensionCatalog.chrome_store_update_url;
    };

  updateUrlExternalExtensionFile =
    extension:
    externalExtensionFile extension.id {
      external_update_url = extension.update_url;
    };

  crxExternalExtensionFile =
    extension:
    externalExtensionFile extension.id {
      external_crx = pkgs.fetchurl {
        inherit (extension) url;
        name = "${extension.id}.crx";
        hash = extension.sha256;
      };
      external_version = extension.version;
    };

  heliumBrowser = pkgs.eupkgs.helium-browser.override {
    commandLineArgs = concatStringsSep " " commandLineArgs;
  };
in
{
  config = mkIf desktopEnabled {
    programs.chromium.enable = true;
    programs.browser = {
      enable = true;
      configurations.helium = heliumConfig;
    };

    environment.systemPackages = attrValues {
      inherit heliumBrowser;

      inherit (pkgs.unstable)
        networkmanagerapplet
        nufraw-thumbnailer
        pavucontrol
        playerctl
        telegram-desktop
        ;
    };

    environment.etc = builtins.listToAttrs (
      map chromeStoreExternalExtensionFile extensionCatalog.chrome_store
      ++ map updateUrlExternalExtensionFile extensionCatalog.update_url
      ++ map crxExternalExtensionFile extensionCatalog.crx
    );

    system.activationScripts.heliumProfileSettings = {
      deps = [ "users" ];
      text = ''
        mkdir -p '${heliumProfileDir}'
        install -m 0644 '${../../browser/helium-profile-avatar.png}' '${heliumProfileDir}/Custom Avatar Picture.png'
        chown 4evy:users \
          '/home/4evy/.config' \
          '/home/4evy/.config/net.imput.helium' \
          '${heliumProfileDir}' \
          '${heliumProfileDir}/Custom Avatar Picture.png' \
          2>/dev/null || true

        if command -v runuser >/dev/null 2>&1; then
          token="$(runuser -u 4evy -- ${pkgs.gh}/bin/gh auth token 2>/dev/null || true)"
          input="$(${pkgs.jq}/bin/jq -nc --arg token "$token" \
            '{extension_values: (if $token == "" then {} else {"refined-github-personal-token": $token} end)}')"
          printf '%s' "$input" | runuser -u 4evy -- ${getExe config.programs.browser.package} apply-profile-settings \
            --config '${config.programs.browser.configFiles.helium}' \
            --profile-dir '${heliumProfileDir}' \
            --input - || true
        else
          token="$(su -s /bin/sh 4evy -c '${pkgs.gh}/bin/gh auth token' 2>/dev/null || true)"
          input="$(${pkgs.jq}/bin/jq -nc --arg token "$token" \
            '{extension_values: (if $token == "" then {} else {"refined-github-personal-token": $token} end)}')"
          printf '%s' "$input" | su -s /bin/sh 4evy -c \
            '${getExe config.programs.browser.package} apply-profile-settings --config ${config.programs.browser.configFiles.helium} --profile-dir ${heliumProfileDir} --input -' || true
        fi
      '';
    };
  };
}
