{
  description = "My NixOS system flake";

  inputs = {
    eupkgs.inputs.nixpkgs.follows = "nixpkgs-unstable";
    eupkgs.url = "github:euvlok/pkgs";

    nixcord.inputs.nixpkgs.follows = "nixpkgs-unstable";
    nixcord.url = "github:4evy/nixcord";

    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable-small";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    sops-nix.inputs.nixpkgs.follows = "nixpkgs-unstable";
    sops-nix.url = "github:Mic92/sops-nix";
  };

  outputs =
    inputs:
    let
      formatterSystems = [
        "x86_64-linux"
      ];
      ghidraMcpSystems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forAllFormatterSystems = inputs.nixpkgs.lib.genAttrs formatterSystems;
      forAllGhidraMcpSystems = inputs.nixpkgs.lib.genAttrs ghidraMcpSystems;
      commonNixpkgs = import ./modules/cross/nixpkgs.nix { inherit inputs; };
      equicordParseRules = builtins.fromJSON (
        builtins.readFile "${inputs.nixcord}/modules/plugins/parse-rules.json"
      );
      equicordSettings = import ./modules/equicord/settings.nix {
        lib = inputs.nixpkgs.lib;
        parseRules = equicordParseRules;
      };
      mkPkgs =
        system:
        import inputs.nixpkgs {
          inherit system;
          config.allowUnfree = true;
          inherit (commonNixpkgs.nixpkgs) overlays;
        };
      mkEquicordSettingsPackage =
        pkgs:
        pkgs.runCommand "equicord-settings"
          {
            nativeBuildInputs = [ pkgs.jq ];
          }
          ''
            mkdir -p "$out"
            jq . ${pkgs.writeText "equicord-settings.json" (builtins.toJSON equicordSettings.jsonConfig)} > "$out/settings.json"
            cp ${./ansible/files/apps/equicord/quickCss.css} "$out/quickCss.css"
          '';
    in
    {
      lib.equicordSettingsJson = equicordSettings.jsonConfig;

      formatter = forAllFormatterSystems (
        system:
        let
          pkgs = mkPkgs system;
        in
        pkgs.writeShellApplication {
          name = "dotfiles-format";
          runtimeInputs = with pkgs; [
            git
            gofumpt
            nixfmt-tree
            shfmt
          ];
          text = ''
            set -euo pipefail

            repo_dir="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
            cd "$repo_dir"

            find . -path ./.git -prune -o -name '*.sh' -type f -exec shfmt -w -i 2 -bn {} +
            find . -path ./.git -prune -o -name '*.go' -type f -exec gofumpt -w {} +
            treefmt "$@"
          '';
        }
      );

      packages = forAllGhidraMcpSystems (
        system:
        let
          pkgs = mkPkgs system;
          ghidraMcp = pkgs.ghidra-mcp;
          ghidraMcpHeadless = pkgs.ghidra-mcp-headless;
        in
        {
          ghidra-mcp = ghidraMcp;
          ghidra-mcp-headless = ghidraMcpHeadless;
          ghidra-mcp-httpd = ghidraMcpHeadless.httpd;
          ghidra-mcp-bridge = ghidraMcpHeadless.bridge;
          ghidra-mcp-launcher = ghidraMcpHeadless.launcher;
          ghidra = ghidraMcpHeadless.ghidra;
          equicord-settings = mkEquicordSettingsPackage pkgs;

        }
      );

      apps = forAllGhidraMcpSystems (
        system:
        let
          pkgs = mkPkgs system;
          ghidraMcp = pkgs.ghidra-mcp;
          ghidraMcpHeadless = pkgs.ghidra-mcp-headless;
          appFor = program: {
            type = "app";
            inherit program;
            meta.description = "Run a Ghidra MCP entry point";
          };
        in
        {
          ghidra-mcp = appFor "${ghidraMcp}/bin/ghidra-mcp-serve";
          ghidra-mcp-headless = appFor "${ghidraMcpHeadless.launcher}/bin/ghidra-mcp-headless";
          ghidra-mcp-httpd = appFor "${ghidraMcpHeadless.httpd}/bin/ghidra-mcp-httpd";
          ghidra-mcp-bridge = appFor "${ghidraMcpHeadless.bridge}/bin/ghidra-mcp-bridge";
          default = appFor "${ghidraMcp}/bin/ghidra-mcp-serve";
        }
      );

      nixosModules.default = import ./modules/nixos;

      nixosConfigurations = import ./hosts/linux { inherit inputs; };
    };
}
