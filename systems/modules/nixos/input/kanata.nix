{ pkgs, ... }:
let
  inherit (pkgs) kanata-with-cmd;
in
{
  services.kanata = {
    enable = true;
    package = kanata-with-cmd;
    keyboards.main = {
      configFile = ../../../../packages/kanata/kanata.kbd;
    };
  };
}
