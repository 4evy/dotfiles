{ lib, ... }:
{
  boot = {
    consoleLogLevel = lib.mkDefault 3;
    kernelParams = [ "quiet" ];
    plymouth.enable = lib.mkDefault false;
    initrd.systemd.settings.Manager.ShowStatus = lib.mkDefault false;
  };

  systemd.settings.Manager.ShowStatus = lib.mkDefault false;
}
