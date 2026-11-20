{ lib }:
final: prev:
let
  inherit (final)
    dotfilesPackageUpdaters
    dotfilesSourcePins
    unstable
    ;
  inherit (prev) kmscon libtsm;
  inherit (unstable) libnotify python315Packages solaar;
in
{
  # Keep the managed runtime on the stable release ahead of the nixpkgs pin
  bun = unstable.bun.overrideAttrs (
    finalAttrs: previous: {
      version = "1.4.5";
      src = finalAttrs.passthru.sources.${unstable.stdenvNoCC.hostPlatform.system};
      passthru = previous.passthru // {
        updateScript = dotfilesPackageUpdaters.binaryPin "bun";
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
              aarch64-darwin = "sha256-tda8LhPK8U5XyJZh6J79Bz/xYWW0G/5DiCYWQQYJzRA=";
              aarch64-linux = "sha256-GGVqO/DqVkH1eWrkITt1JVV5pwoP3tLzN5M3hVaM34Q=";
              x86_64-linux = "sha256-3LI6GKHC//EtV7zvaW27tC62f94p9DgW7LWVRZokxGM=";
            };
      };
    }
  );

  solaar =
    (solaar.override {
      python3Packages = python315Packages;
    }).overrideAttrs
      (previous: {
        passthru = (previous.passthru or { }) // {
          updateScript = dotfilesPackageUpdaters.flakeInputs [ "nixpkgs-unstable" ];
        };
        patches = (previous.patches or [ ]) ++ [ ../../../packages/solaar/tray.patch ];
        # Desktop notifications load Notify's typelib through the GTK wrapper
        preFixup = (previous.preFixup or "") + ''
          makeWrapperArgs+=(--prefix GI_TYPELIB_PATH : "${libnotify}/lib/girepository-1.0")
        '';
      });

  libtsm = libtsm.overrideAttrs (old: {
    version = lib.lists.head (
      lib.strings.match ".*version: '([^']+)'.*" (
        lib.trivial.readFile "${dotfilesSourcePins.libtsm.outPath}/meson.build"
      )
    );
    src = dotfilesSourcePins.libtsm.outPath;
    passthru = (old.passthru or { }) // {
      updateScript = dotfilesSourcePins.libtsm.updateScript;
    };
  });

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
      passthru = (previousAttrs.passthru or { }) // {
        updateScript = dotfilesSourcePins.kmscon.updateScript;
      };
      mesonFlags = (previousAttrs.mesonFlags or [ ]) ++ [ "-Dtests=false" ];
      doCheck = false;
      doInstallCheck = false;
    }
  );
}
