{
  description = "My NixOS system flake";

  inputs = {
    bun2nix.inputs.flake-parts.follows = "flake-parts";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
    bun2nix.inputs.treefmt-nix.follows = "treefmt-nix";
    bun2nix.url = "github:nix-community/bun2nix";

    catppuccin-discord-css.flake = false;
    catppuccin-discord-css.url = "https://catppuccin.github.io/discord/dist/catppuccin-mocha-pink.theme.css";

    eupkgs.inputs.nixpkgs.follows = "nixpkgs-unstable";
    eupkgs.url = "github:euvlok/pkgs";

    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
    flake-parts.url = "github:hercules-ci/flake-parts";

    nixcord.inputs.flake-parts.follows = "flake-parts";
    nixcord.inputs.nixpkgs.follows = "nixpkgs-unstable";
    nixcord.url = "github:4evy/nixcord";

    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable-small";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
    treefmt-nix.url = "github:numtide/treefmt-nix";
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.flake-parts.flakeModules.partitions
        ./lib/flake.nix
      ];
    };
}
