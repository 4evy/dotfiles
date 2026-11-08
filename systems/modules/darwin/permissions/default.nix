{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (pkgs) dotfiles-typescript-tools;
  permissionsHelper = lib.meta.getExe' dotfiles-typescript-tools "dotfiles-permissions";
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
          ${permissionsHelper} --user ${lib.strings.escapeShellArg config.system.primary.user}
      '';
    };
    launchd.deps = [ "dotfiles-permissions" ];
  };
}
