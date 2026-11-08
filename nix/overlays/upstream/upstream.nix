{ lib }:
final: prev:
let
  inherit (final)
    dbus
    dotfilesSourcePins
    inotify-tools
    unstable
    ;
  inherit (prev) kmscon libtsm;
  inherit (unstable) libnotify python315Packages solaar;
in
{
  # Keep the managed runtime on the stable release ahead of the nixpkgs pin
  bun = unstable.bun.overrideAttrs (
    finalAttrs: previous: {
      version = "1.4.4";
      src = finalAttrs.passthru.sources.${unstable.stdenvNoCC.hostPlatform.system};
      passthru = previous.passthru // {
        # Reuse upstream's version-aware URLs with our per-platform hashes
        sources =
          lib.attrsets.mapAttrs
            (
              platform: hash:
              previous.passthru.sources.${platform}.overrideAttrs {
                inherit hash;
              }
            )
            {
              aarch64-darwin = "sha256-wkDX8My5DCY6hJ/NsJt+5iYw2SE0jtaq/ahrnVd7xRA=";
              aarch64-linux = "sha256-uqa7NvUdblhWHgK76oJQOKnfRU9nPW13bou/hvjHhQ4=";
              x86_64-linux = "sha256-4ERutVmVdy65iUvrrppr42jZhai5Jx7hJEhvmUbu3XY=";
            };
      };
    }
  );

  solaar =
    (solaar.override {
      python3Packages = python315Packages;
    }).overrideAttrs
      (previous: {
        patches = (previous.patches or [ ]) ++ [ ../../../packages/solaar/tray.patch ];
        # Desktop notifications load Notify's typelib through the GTK wrapper
        preFixup = (previous.preFixup or "") + ''
          makeWrapperArgs+=(--prefix GI_TYPELIB_PATH : "${libnotify}/lib/girepository-1.0")
        '';
      });

  libtsm = libtsm.overrideAttrs {
    version = lib.lists.head (
      lib.strings.match ".*version: '([^']+)'.*" (
        lib.trivial.readFile "${dotfilesSourcePins.libtsm.outPath}/meson.build"
      )
    );
    src = dotfilesSourcePins.libtsm.outPath;
  };

  kmscon = (kmscon.override { inherit (final) libtsm; }).overrideAttrs (
    _finalAttrs: previousAttrs: {
      version =
        lib.lists.head (
          lib.strings.match ".*project\\([[:space:]]*'kmscon',[[:space:]]*'c',[[:space:]]*version: '([^']+)'.*" (
            lib.trivial.readFile "${dotfilesSourcePins.kmscon.outPath}/meson.build"
          )
        )
        + "-unstable-${lib.strings.substring 0 8 dotfilesSourcePins.kmscon.revision}";
      src = dotfilesSourcePins.kmscon.outPath;
      # The pinned source already includes Nixpkgs' libseat logging fix
      patches = lib.lists.filter (
        patch: !(lib.strings.hasInfix "153db63d679df719a99dd36505f9c2f55d9c59f6" (patch.url or ""))
      ) (previousAttrs.patches or [ ]);
      buildInputs = previousAttrs.buildInputs ++ lib.attrsets.attrValues { inherit dbus; };
      mesonFlags = (previousAttrs.mesonFlags or [ ]) ++ [ "-Dtests=false" ];
      doCheck = false;
      doInstallCheck = false;
      # The pinned source installs kmscon itself as an ELF binary, only the
      # launcher script contains a command path that needs rewriting
      postFixup = ''
        substituteInPlace $out/bin/kmscon-launch-gui \
          --replace-fail "inotifywait" "${lib.meta.getExe' inotify-tools "inotifywait"}"
      '';
    }
  );
}
