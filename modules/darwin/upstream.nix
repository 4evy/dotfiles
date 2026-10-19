{ config, lib, ... }:
let
  alias = from: to: lib.mkAliasOptionModule (lib.splitString "." from) (lib.splitString "." to);
in
{
  # Bridge the contracts used by the pinned AI and Nixcord modules
  imports = [
    (alias "launchd.user.envVariables" "launchd.environment.variables")
    (alias "system.activationScripts.users.text" "system.activation.steps.upstream-users.text")
    (alias "system.activationScripts.applications.text" "system.activation.steps.upstream-applications.text")
  ];

  options = {
    meta = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      internal = true;
    };
    system.requiresPrimaryUser = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      internal = true;
    };
    launchd.user.agents = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options.serviceConfig = lib.mkOption {
            type = lib.types.attrsOf lib.types.anything;
            default = { };
          };
        }
      );
      default = { };
      internal = true;
    };
    environment.extraInit = lib.mkOption {
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
    launchd.agents = lib.mapAttrs (_: agent: {
      enable = true;
      config = agent.serviceConfig;
    }) config.launchd.user.agents;
    programs.zsh.env.extra = config.environment.extraInit;
    programs.bash.bashrc.extra = config.environment.extraInit;
    system.activation.steps = {
      upstream-users = {
        deps = [ "users" ];
        # Reject AI file conflicts before any system activation steps run
        checks = lib.mkIf config.programs.ai.user.enable (
          lib.darwin.shell.asUser config.system.primary.user [
            "/usr/bin/env"
            "DRY_RUN=1"
            (lib.getExe config.programs.ai.user.activationPackage)
          ]
        );
      };
      launchd.deps = [ "upstream-users" ];
      upstream-applications.deps = [ "applications" ];
      extra.deps = [ "upstream-applications" ];
    };
  };
}
