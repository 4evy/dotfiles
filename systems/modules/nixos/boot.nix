{ lib, ... }:
{
  boot = {
    consoleLogLevel = lib.modules.mkDefault 3;
    kernelParams = [ "quiet" ];
    plymouth.enable = lib.modules.mkDefault false;
    initrd.systemd.settings.Manager.ShowStatus = lib.modules.mkDefault false;
  };

  systemd.settings.Manager.ShowStatus = lib.modules.mkDefault false;
}
