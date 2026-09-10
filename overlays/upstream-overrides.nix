{ lib }:
final: prev:
let
  inherit (final) dotfilesSourcePins;
in
{
  libtsm = prev.libtsm.overrideAttrs {
    version = builtins.head (
      builtins.match ".*version: '([^']+)'.*" (
        builtins.readFile "${dotfilesSourcePins.libtsm.outPath}/meson.build"
      )
    );
    src = dotfilesSourcePins.libtsm.outPath;
  };

  kmscon = (prev.kmscon.override { inherit (final) libtsm; }).overrideAttrs (
    _finalAttrs: previousAttrs: {
      # The pin follows upstream main rather than a release tag.
      version = "10.0.2-unstable-2026-08-20";
      src = dotfilesSourcePins.kmscon.outPath;
      buildInputs = previousAttrs.buildInputs ++ [ final.dbus ];
      mesonFlags = (previousAttrs.mesonFlags or [ ]) ++ [ "-Dtests=false" ];
      doCheck = false;
      doInstallCheck = false;
      # The pinned source installs kmscon itself as an ELF binary; only the
      # launcher script contains a command path that needs rewriting.
      postFixup = ''
        substituteInPlace $out/bin/kmscon-launch-gui \
          --replace-fail "inotifywait" "${lib.getExe' final.inotify-tools "inotifywait"}"
      '';
    }
  );
}
