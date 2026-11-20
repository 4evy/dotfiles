{
  config,
  lib,
  options,
  ...
}:
{
  options = {
    meta = lib.options.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      internal = true;
    };
    system.requiresPrimaryUser = lib.options.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      internal = true;
    };
    environment.extraInit = lib.options.mkOption {
      type = lib.types.lines;
      default = "";
      internal = true;
    };
  };

  config = {
    assertions = [
      {
        assertion = config.system.requiresPrimaryUser == [ ] || config.system.primary.user != null;
        message = "The imported modules require system.primary.user";
      }
    ];
    # Preserve upstream mkDefault/mkForce priorities across this bridge
    programs.zsh.env.extra = lib.modules.mkAliasAndWrapDefsWithPriority lib.trivial.id options.environment.extraInit;
    programs.bash.bashrc.extra = lib.modules.mkAliasAndWrapDefsWithPriority lib.trivial.id options.environment.extraInit;
    # Reject AI file conflicts before any system activation steps run
    system.activation.steps.legacy-users.checks = lib.modules.mkIf config.programs.ai.user.enable (
      lib.darwin.shell.asUser config.system.primary.user [
        "/usr/bin/env"
        "DRY_RUN=1"
        (lib.meta.getExe config.programs.ai.user.activationPackage)
      ]
    );
  };
}
