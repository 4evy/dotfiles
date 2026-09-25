{ lib }:
final: prev:
let
  inherit (final) dotfilesSourcePins;
in
{
  # These runtimes execute repository-owned Ansible modules and Solaar helpers.
  ansible = final.unstable.python314Packages.toPythonApplication final.unstable.python314Packages.ansible-core;
  ansible-lint = final.unstable.ansible-lint.override {
    python3Packages = final.unstable.python314Packages;
    inherit (final) ansible;
  };
  solaar =
    (final.unstable.solaar.override {
      python3Packages = final.unstable.python314Packages;
    }).overrideAttrs
      (previous: {
        # Wrap our launcher with the same Python and GTK environment as Solaar.
        postInstall = (previous.postInstall or "") + ''
          install -Dm755 ${../dotfiles/dot_local/lib/python/solaar_no_tray.py} $out/bin/solaar-no-tray
          substituteInPlace $out/bin/solaar-no-tray \
            --replace-fail '#!/usr/bin/env python3.14' '#!${final.unstable.python314.interpreter}'
        '';
      });

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
