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

  options.flake.lib = lib.options.mkOption {
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
            runtime = builtins.fromJSON runtimeJSON;
          in
          inputs.ai.lib.mkConfigs {
            inherit (runtime) system;
            host = lib.trivial.importJSON runtime.hostFile;
          };
        patchesSource = inputs.patches.outPath;
        checkNames = lib.attrsets.genAttrs config.systems (
          system: lib.attrsets.attrNames inputs.self.checks.${system}
        );
        equicordQuickCss = equicord.quickCss;
        equicordSettingsJson = equicord.settings.jsonConfig;
        patchStackSources = inputs.patches.stackSources;
        spectrumBuildData = {
          stackSources = inputs.patches.stackSources;
          config = import ../lib/spectrum/config.nix { inherit lib; };
        };
        supportedSystems = config.systems;
      };
    };
  };
}
