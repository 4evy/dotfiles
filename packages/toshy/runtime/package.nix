{
  callPackage,
  dotfilesSourcePins,
  lib,
  python315,
  symlinkJoin,
}:
let
  sourcePin = dotfilesSourcePins.toshy;
  source = sourcePin.outPath;
  version = lib.removePrefix "Toshy_v" sourcePin.version;
  upstreamRuntime =
    (callPackage "${source}/nix/toshy-runtime.nix" {
      toshySrc = source;
      python3 = python315;
    }).overrideAttrs
      {
        doCheck = false;
        doInstallCheck = false;
      };
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
    inherit (sourcePin) revision version;
  };
  inherit (upstreamRuntime) meta;
}
