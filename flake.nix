{
  description = "My NixOS system flake";

  inputs = {
    browser.inputs.nixpkgs.follows = "nixpkgs-unstable";
    browser.url = "github:4evy/browser";

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
      overlays = import ./overlays { inherit inputs; };
      flake = import ./lib/flake.nix { inherit inputs overlays; };
    in
    {
      inherit (flake)
        apps
        checks
        formatter
        packages
        ;

      lib = {
        equicordSettingsJson = flake.equicordSettings.jsonConfig;
        supportedSystems = flake.systems;
      };

      inherit overlays;

      nixosModules.default = import ./modules/nixos;

      nixosConfigurations = import ./hosts/linux { inherit inputs; };
    };
}
