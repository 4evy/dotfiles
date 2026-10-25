{ inputs, lib }:
_final: prev:
let
  inherit (prev) stdenv;
  unstable = import inputs.nixpkgs-unstable {
    localSystem = stdenv.hostPlatform;
    inherit (prev) config;
  };
  inherit (unstable) newScope;

  # Give eupkgs its own recursive callPackage scope on top of unstable. This
  # lets eupkgs packages see one another without adding the entire overlay to
  # the top-level package set or recomputing the nixpkgs fixed point.
  eupkgsScope = lib.makeScope newScope (
    scopeFinal: inputs.eupkgs.overlays.default scopeFinal unstable
  );
  eupkgs = lib.removeAttrs eupkgsScope [
    "_internalCallByNamePackageFile"
    "callPackage"
    "newScope"
    "overrideScope"
    "packages"
  ];
in
{
  inherit eupkgs unstable;
}
