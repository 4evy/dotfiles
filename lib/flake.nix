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

  equicordParseRules = builtins.fromJSON (
    builtins.readFile "${inputs.nixcord}/modules/plugins/parse-rules.json"
  );
  blackRoseDollPalette = builtins.fromJSON (
    builtins.readFile ../dotfiles/.chezmoitemplates/black_rose_doll_palette.json
  );
  blackRoseDollVariants = [
    "dark"
    "light"
  ];
  blackRoseDollRoles = variant: builtins.attrNames blackRoseDollPalette.${variant};
  catppuccinDiscordRoles = [
    "rosewater"
    "flamingo"
    "pink"
    "mauve"
    "red"
    "maroon"
    "peach"
    "yellow"
    "green"
    "teal"
    "sky"
    "sapphire"
    "blue"
    "lavender"
    "text"
    "subtext1"
    "subtext0"
    "overlay2"
    "overlay1"
    "overlay0"
    "surface2"
    "surface1"
    "surface0"
    "base"
    "mantle"
    "crust"
  ];
  catppuccinDiscordPalettes = {
    dark = {
      rosewater = "#f5e0dc";
      flamingo = "#f2cdcd";
      pink = "#f5c2e7";
      mauve = "#cba6f7";
      red = "#f38ba8";
      maroon = "#eba0ac";
      peach = "#fab387";
      yellow = "#f9e2af";
      green = "#a6e3a1";
      teal = "#94e2d5";
      sky = "#89dceb";
      sapphire = "#74c7ec";
      blue = "#89b4fa";
      lavender = "#b4befe";
      text = "#cdd6f4";
      subtext1 = "#bac2de";
      subtext0 = "#a6adc8";
      overlay2 = "#9399b2";
      overlay1 = "#7f849c";
      overlay0 = "#6c7086";
      surface2 = "#585b70";
      surface1 = "#45475a";
      surface0 = "#313244";
      base = "#1e1e2e";
      mantle = "#181825";
      crust = "#11111b";
    };
    light = {
      rosewater = "#dc8a78";
      flamingo = "#dd7878";
      pink = "#ea76cb";
      mauve = "#8839ef";
      red = "#d20f39";
      maroon = "#e64553";
      peach = "#fe640b";
      yellow = "#df8e1d";
      green = "#40a02b";
      teal = "#179299";
      sky = "#04a5e5";
      sapphire = "#209fb5";
      blue = "#1e66f5";
      lavender = "#7287fd";
      text = "#4c4f69";
      subtext1 = "#5c5f77";
      subtext0 = "#6c6f85";
      overlay2 = "#7c7f93";
      overlay1 = "#8c8fa1";
      overlay0 = "#9ca0b0";
      surface2 = "#acb0be";
      surface1 = "#bcc0cc";
      surface0 = "#ccd0da";
      base = "#eff1f5";
      mantle = "#e6e9ef";
      crust = "#dce0e8";
    };
  };
  catppuccinDiscordCss =
    builtins.replaceStrings
      (lib.concatMap (
        variant: map (role: catppuccinDiscordPalettes.${variant}.${role}) catppuccinDiscordRoles
      ) blackRoseDollVariants)
      (lib.concatMap (
        variant: map (role: blackRoseDollPalette.${variant}.${role}) catppuccinDiscordRoles
      ) blackRoseDollVariants)
      (builtins.readFile inputs.catppuccin-discord-css);
  equicordLocalCss =
    builtins.replaceStrings
      (lib.concatMap (
        variant: map (role: "__BRD_${variant}_${role}__") (blackRoseDollRoles variant)
      ) blackRoseDollVariants)
      (lib.concatMap (
        variant: map (role: blackRoseDollPalette.${variant}.${role}) (blackRoseDollRoles variant)
      ) blackRoseDollVariants)
      (builtins.readFile ../packages/equicord/quickCss.css);
  equicordQuickCss = "${catppuccinDiscordCss}\n${equicordLocalCss}";
  equicordSettings =
    (import ../modules/equicord/settings.nix {
      inherit lib;
      parseRules = equicordParseRules;
    })
    // {
      quickCss = equicordQuickCss;
    };

  mkEquicordSettingsPackage =
    pkgs:
    pkgs.runCommand "equicord-settings"
      {
        meta.description = "Equicord settings shared by NixOS and non-NixOS installations";
        nativeBuildInputs = [ pkgs.jq ];
        strictDeps = true;
      }
      ''
        mkdir -p "$out"
        jq . ${pkgs.writeText "equicord-settings.json" (builtins.toJSON equicordSettings.jsonConfig)} > "$out/settings.json"
        cp ${pkgs.writeText "equicord-quick-css" equicordQuickCss} "$out/quickCss.css"
      '';

  mkPackages =
    pkgs:
    let
      ghidraMcp = pkgs.ghidra-mcp;
      ghidraMcpHeadless = pkgs.ghidra-mcp-headless;
    in
    {
      bun2nix = pkgs.bun2nix;
      default = ghidraMcp;
      dotfiles-python = pkgs.dotfiles-python;
      equicord-settings = mkEquicordSettingsPackage pkgs;
      ghidra-mcp = ghidraMcp;
      ghidra-mcp-bridge = ghidraMcpHeadless.bridge;
      ghidra-mcp-headless = ghidraMcpHeadless;
      ghidra-mcp-httpd = ghidraMcpHeadless.httpd;
      ghidra-mcp-launcher = ghidraMcpHeadless.launcher;
      ghidra = ghidraMcpHeadless.ghidra;
      kanata-with-cmd = pkgs.kanata-with-cmd;
    }
    // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
      bluebuild-v2 = pkgs.bluebuild-v2;
      check-jsonschema = pkgs.check-jsonschema;
      ghostty-patched = pkgs.ghostty-patched;
      hyper-window-tiling-gnome = pkgs.hyper-window-tiling-gnome;
      hyper-window-tiling-kde = pkgs.hyper-window-tiling-kde;
      kmscon = pkgs.kmscon;
      terminal-theme-tools = pkgs.terminal-theme-tools;
      uresourced = pkgs.uresourced;
    };

  mkApps =
    packages:
    let
      appFor = program: description: {
        type = "app";
        inherit program;
        meta = { inherit description; };
      };
    in
    {
      ghidra-mcp = appFor "${packages.ghidra-mcp}/bin/ghidra-mcp-serve" "Run the Ghidra MCP service";
      ghidra-mcp-headless = appFor "${packages.ghidra-mcp-launcher}/bin/ghidra-mcp-headless" "Run the headless Ghidra MCP backend";
      ghidra-mcp-httpd = appFor "${packages.ghidra-mcp-httpd}/bin/ghidra-mcp-httpd" "Run the Ghidra MCP HTTP server";
      ghidra-mcp-bridge = appFor "${packages.ghidra-mcp-bridge}/bin/ghidra-mcp-bridge" "Run the Ghidra MCP bridge";
      default = appFor "${packages.ghidra-mcp}/bin/ghidra-mcp-serve" "Run the Ghidra MCP service";
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
    extraInputsFlake = ../nix/dev;
    module = ../nix/dev/flake-module.nix;
  };

  partitions.nixos = {
    extraInputsFlake = ../nix/nixos;
    module =
      {
        inputs,
        moduleWithSystem,
        ...
      }:
      let
        nixosModule = moduleWithSystem (
          { config, ... }:
          { ... }:
          {
            imports = [ ../modules/nixos ];

            # Keep every locally packaged program used by NixOS identical to
            # the corresponding packages.<system> flake output. Consumers of
            # this module do not have to recreate our overlay or package
            # selection.
            _module.args.dotfilesPackages = config.packages;
            _module.args.dotfilesEquicordSettings = equicordSettings;
          }
        );
      in
      {
        flake = {
          nixosModules.default = nixosModule;
          nixosConfigurations = import ../hosts/linux {
            inherit inputs;
            inherit nixosModule;
          };
        };
      };
  };

  flake = {
    lib = {
      inherit equicordQuickCss;
      equicordSettingsJson = equicordSettings.jsonConfig;
      supportedSystems = systems;
    };

    inherit overlays;
  };

  perSystem =
    {
      config,
      pkgs,
      system,
      ...
    }:
    {
      _module.args.pkgs = import inputs.nixpkgs {
        localSystem = system;
        config.allowUnfree = true;
        overlays = [ overlays.default ];
      };

      packages = mkPackages pkgs;
      apps = mkApps config.packages;
    };
}
