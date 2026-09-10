{ inputs }:
let
  inherit (inputs.nixpkgs) lib;

  dependencies = import ./dependencies.nix { inherit inputs lib; };
  sources = import ./sources.nix { inherit inputs; };
  localPackages = import ./local-packages.nix { inherit inputs lib; };
  upstreamOverrides = import ./upstream-overrides.nix { inherit lib; };

  packages = lib.composeManyExtensions [
    dependencies
    sources
    localPackages
    upstreamOverrides
  ];
in
{
  inherit dependencies packages;
  default = packages;
}
