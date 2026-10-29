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
        # Keep config exports on the same followed inputs as the runtime
        aiConfigs =
          runtimeJSON:
          let
            runtime = lib.fromJSON runtimeJSON;
          in
          inputs.ai.lib.mkConfigs {
            inherit (runtime) system;
            host = lib.importJSON runtime.hostFile;
          };
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
