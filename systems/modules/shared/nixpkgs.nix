{ inputs, ... }:
let
  overlays = import ../../../nix/overlays { inherit inputs; };
in
{
  # This module is shared by NixOS and nix-darwin configurations.
  _class = null;

  nixpkgs = {
    config.allowUnfree = true;
    overlays = [ overlays.default ];
  };
}
