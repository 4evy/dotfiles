{
  inputs,
  lib,
  ...
}:
let
  # Keep this list explicit: these are the systems used by this repository's
  # NixOS host and macOS workstation, and for which its custom packages are
  # intentionally supported.
  systems = [
    "aarch64-darwin"
    "x86_64-linux"
  ];

  overlays = import ../overlays { inherit inputs; };
  toshySource = inputs.source-toshy;

  equicordParseRules = lib.importJSON "${inputs.nixcord}/modules/plugins/parse-rules.json";
  catppuccinCustomPalette =
    (lib.importJSON ../dotfiles/.chezmoidata/catppuccin_custom.json).catppuccin_custom;
  equicordExceptionsCss = builtins.readFile ../packages/equicord-settings/quick-css.css;
  equicordQuickCss = import ../packages/equicord-settings/theme.nix {
    inherit lib;
    palette = catppuccinCustomPalette;
    exceptions = equicordExceptionsCss;
  };
  equicordSettings =
    (import ../packages/equicord-settings/settings.nix {
      inherit lib;
      parseRules = equicordParseRules;
    })
    // {
      quickCss = equicordQuickCss;
    };

  mkPackages =
    pkgs:
    {
      inherit (pkgs) bun2nix;
      default = pkgs.dotfiles-python;
      dotfiles-nix-tools = pkgs.buildEnv {
        name = "dotfiles-nix-tools";
        paths =
          (with pkgs; [
            deadnix
            nh
            nil
            nix-output-monitor
            nix-tree
            nixd
            nixfmt
            statix
          ])
          ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
            inputs.raycast.packages.${pkgs.stdenv.hostPlatform.system}.raycast
            inputs.raycast.packages.${pkgs.stdenv.hostPlatform.system}.raycast-manager
          ];
      };
      inherit (pkgs) dotfiles-python;
      equicord-settings = pkgs.callPackage ../packages/equicord-settings/package.nix {
        quickCss = equicordQuickCss;
        settings = equicordSettings.jsonConfig;
      };
      inherit (pkgs) theme-run;
    }
    // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
      inherit (pkgs)
        bluebuild-v2
        check-jsonschema
        hyper-window-tiling-gnome
        hyper-window-tiling-kde
        kmscon
        toshy-runtime
        uresourced
        ;
    };

in
{
  inherit systems;

  partitionedAttrs = {
    checks = "dev";
    devShells = "dev";
    formatter = "dev";
    nixosConfigurations = "nixos";
    nixosModules = "nixos";
  };

  partitions.dev = {
    module = ../nix/dev/flake-module.nix;
  };

  partitions.nixos = {
    module =
      {
        inputs,
        ...
      }:
      let
        nixosModule = { ... }: {
          imports = [
            ../modules/nixos
            "${toshySource}/nix/nixos-module.nix"
            inputs.browser.nixosModules.default
            inputs.determinate.nixosModules.default
            inputs.nixcord.nixosModules.nixcord
            inputs.patches.nixosModules.default
            inputs.vicinae.nixosModules.default
          ];

          _module.args = {
            inherit inputs;
            dotfilesEquicordSettings = equicordSettings;
          };
        };

        nixosConfigurations = import ../hosts/linux {
          inherit inputs;
          inherit nixosModule;
        };
      in
      {
        flake = {
          inherit nixosConfigurations;
          nixosModules.default = nixosModule;
        };
      };
  };

  flake = {
    patchStackSources = inputs.patches.stackSources;
    lib = {
      inherit equicordQuickCss;
      equicordSettingsJson = equicordSettings.jsonConfig;
      patchStackSources = inputs.patches.stackSources;
      supportedSystems = systems;
    };

    inherit overlays;
  };

  perSystem =
    {
      pkgs,
      system,
      ...
    }:
    {
      _module.args.pkgs = import inputs.nixpkgs {
        localSystem = system;
        config = {
          allowUnfree = true;
        };
        overlays = [ overlays.default ];
      };

      packages = mkPackages pkgs;
    };
}
