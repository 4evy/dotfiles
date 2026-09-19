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
      version = "10.0.3-unstable-2026-09-18";
      src = dotfilesSourcePins.kmscon.outPath;
      # efda2b53 changed the logging API but missed the libseat callback.
      postPatch = (previousAttrs.postPatch or "") + ''
        substituteInPlace src/uterm/vt_libseat.c \
          --replace-fail 'log_submit(LOG_DEFAULT, log_level(level), fmt, args);' \
            'log_submit(log_level(level), LOG_SUBSYSTEM, fmt, args);'
      '';
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
