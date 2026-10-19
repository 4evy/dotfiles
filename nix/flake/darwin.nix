{
  config,
  equicord,
  inputs,
  moduleLocation,
  ...
}:
{
  _class = "flake";

  flake = {
    darwin.modules.default = {
      _class = "darwin";
      _file = "${toString moduleLocation}#darwin.modules.default";
      imports = [
        ../../modules/darwin
        inputs.ai.darwinModules.default
        inputs.nixcord.darwinModules.nixcord
      ];
      _module.args = {
        inherit inputs;
        dotfilesEquicordSettings = equicord.settings;
      };
    };
    darwin.configurations.evy = inputs.darwin.lib.darwin.system {
      modules = [
        config.flake.darwin.modules.default
        ../../hosts/macos/configuration.nix
      ];
    };
  };
}
