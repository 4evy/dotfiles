{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (pkgs) dotfiles-typescript-tools;
  permissionsHelper = lib.meta.getExe' dotfiles-typescript-tools "dotfiles-permissions";
  farstepPackage =
    config.launchd.user.agents.farstep-desktop.serviceConfig.EnvironmentVariables.FARSTEP_PACKAGE_PATH
      or null;
  farstepEnv = lib.strings.optionalString (
    farstepPackage != null
  ) "DOTFILES_FARSTEP_PACKAGE=${lib.strings.escapeShellArg farstepPackage} ";
in
{
  environment.system.packages = [ dotfiles-typescript-tools ];

  system.activation.steps = {
    dotfiles-permissions = {
      deps = [
        "dotfiles-applications"
        "keyboard-app"
      ];
      text = ''
        PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
          ${farstepEnv}${permissionsHelper} --user ${lib.strings.escapeShellArg config.system.primary.user}
      '';
    };
    launchd.deps = [ "dotfiles-permissions" ];
  };
}
