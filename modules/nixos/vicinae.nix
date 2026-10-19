{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
let
  inherit (pkgs) stdenv;
  vicinaePackage = inputs.vicinae.packages.${stdenv.hostPlatform.system}.default;
in
{
  boot.kernelModules = [ "uinput" ];

  environment.systemPackages = lib.attrValues { inherit vicinaePackage; };

  programs.vicinae.input-server = {
    enable = true;
    package = vicinaePackage;
  };

  systemd.user.services.vicinae = {
    description = "Vicinae launcher daemon";
    documentation = [ "https://docs.vicinae.com" ];
    after = [ "graphical-session.target" ];
    partOf = [ "graphical-session.target" ];
    wantedBy = [ "graphical-session.target" ];
    unitConfig.ConditionUser = config.local.user.name;
    serviceConfig = {
      Type = "simple";
      ExecStart = "${lib.getExe vicinaePackage} server --replace";
      Restart = "always";
      RestartSec = 60;
      KillMode = "process";
    };
  };
}
