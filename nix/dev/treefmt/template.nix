{ lib, pkgs }:
pkgs.writeShellApplication {
  name = "template-format";
  text = ''
    exec ${lib.meta.getExe pkgs.python3} ${./template.py} \
      ${lib.meta.getExe pkgs.prettier} "$@"
  '';
}
