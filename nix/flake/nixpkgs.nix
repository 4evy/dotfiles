{ config, inputs, ... }:
{
  _class = "flake";

  flake.overlays = import ../../overlays { inherit inputs; };

  perSystem = { system, ... }: {
    _module.args.pkgs = import inputs.nixpkgs {
      localSystem = system;
      config.allowUnfree = true;
      overlays = [ config.flake.overlays.default ];
    };
  };
}
