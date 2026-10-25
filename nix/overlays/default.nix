{ inputs }:
let
  inherit (inputs.nixpkgs) lib;

  dependencies = import ./dependencies.nix { inherit inputs lib; };
  sources = import ./sources.nix { inherit inputs lib; };
  localPackages = import ./packages/packages.nix { inherit inputs lib; };
  upstreamOverrides = import ./upstream/upstream.nix { inherit lib; };

  packages = lib.composeManyExtensions [
    dependencies
    sources
    localPackages
    (import ./applications.nix { inherit inputs lib; })
    upstreamOverrides
  ];
in
{
  inherit dependencies packages;
  default = packages;
}
