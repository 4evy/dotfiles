{
  config,
  equicord,
  inputs,
  ...
}:
{
  _class = "flake";

  flake = {
    nixosModules.default = {
      imports = [
        ../../systems/modules/nixos
        inputs.ai.nixosModules.default
        "${inputs.source-toshy}/nix/nixos-module.nix"
        inputs.tweezle.nixosModules.default
        inputs.determinate.nixosModules.default
        inputs.nixcord.nixosModules.nixcord
        inputs.vicinae.nixosModules.default
      ];
      _module.args = {
        inherit inputs;
        dotfilesEquicordSettings = equicord.settings;
      };
    };
    nixosConfigurations = import ../../systems/hosts/linux {
      inherit inputs;
      nixosModule = config.flake.nixosModules.default;
    };
  };
}
