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
  inherit (unstable) libnotify python314Packages solaar;
in
{
  inherit (unstable) go_1_27;

  # Keep the managed runtime on the stable release ahead of the nixpkgs pin
  bun = unstable.bun.overrideAttrs (
    finalAttrs: previous: {
      version = "1.4.4";
      src = finalAttrs.passthru.sources.${unstable.stdenvNoCC.hostPlatform.system};
      passthru = previous.passthru // {
        # Reuse upstream's version-aware URLs with our per-platform hashes
        sources =
          lib.mapAttrs
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
      python3Packages = python314Packages;
    }).overrideAttrs
      (previous: {
        patches = (previous.patches or [ ]) ++ [ ../../../packages/solaar/tray.patch ];
        # Desktop notifications load Notify's typelib through the GTK wrapper
        preFixup = (previous.preFixup or "") + ''
          makeWrapperArgs+=(--prefix GI_TYPELIB_PATH : "${libnotify}/lib/girepository-1.0")
        '';
      });

  libtsm = libtsm.overrideAttrs {
    version = lib.head (
      lib.match ".*version: '([^']+)'.*" (lib.readFile "${dotfilesSourcePins.libtsm.outPath}/meson.build")
    );
    src = dotfilesSourcePins.libtsm.outPath;
  };

  kmscon = (kmscon.override { inherit (final) libtsm; }).overrideAttrs (
    _finalAttrs: previousAttrs: {
      version =
        lib.head (
          lib.match ".*project\\([[:space:]]*'kmscon',[[:space:]]*'c',[[:space:]]*version: '([^']+)'.*" (
            lib.readFile "${dotfilesSourcePins.kmscon.outPath}/meson.build"
          )
        )
        + "-unstable-${lib.substring 0 8 dotfilesSourcePins.kmscon.revision}";
      src = dotfilesSourcePins.kmscon.outPath;
      # The pinned source already includes Nixpkgs' libseat logging fix
      patches = lib.filter (
        patch: !(lib.hasInfix "153db63d679df719a99dd36505f9c2f55d9c59f6" (patch.url or ""))
      ) (previousAttrs.patches or [ ]);
      buildInputs = previousAttrs.buildInputs ++ lib.attrValues { inherit dbus; };
      mesonFlags = (previousAttrs.mesonFlags or [ ]) ++ [ "-Dtests=false" ];
      doCheck = false;
      doInstallCheck = false;
      # The pinned source installs kmscon itself as an ELF binary, only the
      # launcher script contains a command path that needs rewriting
      postFixup = ''
        substituteInPlace $out/bin/kmscon-launch-gui \
          --replace-fail "inotifywait" "${lib.getExe' inotify-tools "inotifywait"}"
      '';
    }
  );
}
