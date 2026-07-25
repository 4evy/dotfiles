{
  inputs,
  overlays,
}:
let
  lib = inputs.nixpkgs.lib;

  # Keep this list explicit: these are the systems used by this repository's
  # NixOS host and macOS workstation, and for which its custom packages are
  # intentionally supported.
  systems = [
    "aarch64-darwin"
    "x86_64-linux"
  ];

  forAllSystems = lib.genAttrs systems;

  mkPkgs =
    system:
    import inputs.nixpkgs {
      inherit system;
      config.allowUnfree = true;
      overlays = [ overlays.default ];
    };

  equicordParseRules = builtins.fromJSON (
    builtins.readFile "${inputs.nixcord}/modules/plugins/parse-rules.json"
  );
  equicordSettings = import ../modules/equicord/settings.nix {
    inherit lib;
    parseRules = equicordParseRules;
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
        cp ${../packages/equicord/quickCss.css} "$out/quickCss.css"
      '';

  mkFormatter =
    pkgs:
    pkgs.writeShellApplication {
      name = "dotfiles-format";
      meta.description = "Format the dotfiles repository";
      runtimeInputs = [
        pkgs.clang-tools
        pkgs.git
        pkgs.nixfmt-tree
        pkgs.shfmt
      ];
      text = ''
        set -euo pipefail

        repo_dir="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
        cd "$repo_dir"

        shell_files=()
        while IFS= read -r -d "" file; do
          shell_files+=("$file")
        done < <(git ls-files --cached --others --exclude-standard -z -- '*.sh')
        ((''${#shell_files[@]} == 0)) || shfmt -w -i 2 -bn "''${shell_files[@]}"

        c_files=()
        while IFS= read -r -d "" file; do
          c_files+=("$file")
        done < <(git ls-files --cached --others --exclude-standard -z -- '*.c' '*.h')
        ((''${#c_files[@]} == 0)) || clang-format -i "''${c_files[@]}"

        treefmt "$@"
      '';
    };

  mkPackages =
    pkgs:
    let
      ghidraMcp = pkgs.ghidra-mcp;
      ghidraMcpHeadless = pkgs.ghidra-mcp-headless;
    in
    {
      default = ghidraMcp;
      dotfiles-python = pkgs.dotfiles-python;
      equicord-settings = mkEquicordSettingsPackage pkgs;
      ghidra-mcp = ghidraMcp;
      ghidra-mcp-bridge = ghidraMcpHeadless.bridge;
      ghidra-mcp-headless = ghidraMcpHeadless;
      ghidra-mcp-httpd = ghidraMcpHeadless.httpd;
      ghidra-mcp-launcher = ghidraMcpHeadless.launcher;
      ghidra = ghidraMcpHeadless.ghidra;
    }
    // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
      hyper-window-tiling-gnome = pkgs.hyper-window-tiling-gnome;
      hyper-window-tiling-kde = pkgs.hyper-window-tiling-kde;
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

  mkChecks =
    pkgs: packages:
    {
      inherit (packages) dotfiles-python equicord-settings;
    }
    // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
      inherit (packages) terminal-theme-tools;
    };

  perSystem = forAllSystems (
    system:
    let
      pkgs = mkPkgs system;
      packages = mkPackages pkgs;
    in
    {
      inherit packages pkgs;
      apps = mkApps packages;
      checks = mkChecks pkgs packages;
      formatter = mkFormatter pkgs;
    }
  );

  transpose = attribute: lib.mapAttrs (_: systemConfig: systemConfig.${attribute}) perSystem;
in
{
  inherit
    equicordSettings
    systems
    ;

  apps = transpose "apps";
  checks = transpose "checks";
  formatter = transpose "formatter";
  packages = transpose "packages";
}
