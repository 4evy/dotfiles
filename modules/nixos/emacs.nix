{ config, pkgs, ... }:
{
  systemd.user.services.emacs = {
    description = "Helheim Emacs daemon";
    wantedBy = [ "default.target" ];
    unitConfig = {
      ConditionUser = config.local.user.name;
      ConditionPathExists = "%h/.local/share/helheim/early-init.el";
    };
    path = [ pkgs.unstable.emacs-nox ];
    script = ''
      export PATH="/run/current-system/sw/bin:$PATH"
      if [[ -r "$HOME/.config/shell/environment.sh" ]]; then
        source "$HOME/.config/shell/environment.sh"
      fi
      exec ${pkgs.unstable.emacs-nox}/bin/emacs --fg-daemon
    '';
    serviceConfig = {
      Type = "simple";
      Restart = "always";
      RestartSec = 2;
      TimeoutStopSec = 30;
    };
  };
}
