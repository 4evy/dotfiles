{ inputs, ... }:
{
  _class = "flake";

  imports = [
    inputs.flake-parts.flakeModules.partitions
    ./lib.nix
    ./nixpkgs.nix
    ./packages.nix
    ./hjem.nix
  ];

  systems = [
    "aarch64-darwin"
    "x86_64-linux"
  ];

  partitionedAttrs = {
    checks = "dev";
    devShells = "dev";
    formatter = "dev";
    darwin = "darwin";
    nixosConfigurations = "nixos";
    nixosModules = "nixos";
  };

  # Defer development and host modules until their outputs are requested
  partitions = {
    dev.module = ../dev/dev.nix;
    darwin.module = ./darwin.nix;
    nixos.module = ./nixos.nix;
  };
}
