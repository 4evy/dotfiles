{
  config,
  inputs,
  lib,
  ...
}:
let
  equicord = import ../../home/applications/discord/equicord { inherit inputs lib; };
in
{
  _class = "flake";

  options.flake.lib = lib.mkOption {
    type = lib.types.lazyAttrsOf lib.types.raw;
    default = { };
    description = "Repository library functions and metadata";
  };

  config = {
    _module.args = { inherit equicord; };
    flake = {
      patchStackSources = inputs.patches.stackSources;
      lib = {
        patchesSource = inputs.patches.outPath;
        checkNames = lib.genAttrs config.systems (system: lib.attrNames inputs.self.checks.${system});
        equicordQuickCss = equicord.quickCss;
        equicordSettingsJson = equicord.settings.jsonConfig;
        patchStackSources = inputs.patches.stackSources;
        supportedSystems = config.systems;
      };
    };
  };
}
