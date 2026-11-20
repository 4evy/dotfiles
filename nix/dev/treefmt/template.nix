{ lib, pkgs }:
pkgs.writers.writePython3Bin "template-format" {
  makeWrapperArgs = [
    "--add-flag"
    (lib.meta.getExe pkgs.prettier)
  ];
} ./template.py
