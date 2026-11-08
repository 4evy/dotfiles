{
  callPackage,
  dotfilesSourcePins,
  lib,
  python314,
  symlinkJoin,
}:
let
  sourcePin = dotfilesSourcePins.toshy;
  source = sourcePin.outPath;
  version = lib.strings.removePrefix "Toshy_v" sourcePin.version;
  # Use Python 3.14 while upstream dependencies catch up with Python 3.15
  upstreamRuntime =
    (callPackage "${source}/nix/toshy-runtime.nix" {
      toshySrc = source;
      python3 = python314;
    }).overrideAttrs
      (old: {
        doCheck = false;
        doInstallCheck = false;
        passthru = (old.passthru or { }) // {
          inherit (sourcePin) updateScript;
        };
      });
in
symlinkJoin {
  name = "toshy-runtime-${version}";
  paths = [ upstreamRuntime ];
  postBuild = ''
    mkdir -p $out/share/toshy
    echo '${sourcePin.revision}' > $out/share/toshy/revision
    echo '${sourcePin.version}' > $out/share/toshy/version
    ln -s ${source} $out/share/toshy/source
  '';
  passthru = (upstreamRuntime.passthru or { }) // {
    inherit source;
    inherit (sourcePin) revision updateScript version;
  };
  inherit (upstreamRuntime) meta;
}
