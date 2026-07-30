{
  callPackage,
  dotfilesSourcePins,
  ghostty,
  lib,
}:
let
  version = "1.3.2-dev.${builtins.substring 0 7 dotfilesSourcePins.ghostty.revision}";
  source = dotfilesSourcePins.ghostty.outPath;
  patchDirectory = ../patches/ghostty;
  patchNames = lib.filter (name: name != "") (
    lib.splitString "\n" (builtins.readFile (patchDirectory + /series))
  );
in
ghostty.overrideAttrs (
  finalAttrs: _: {
    inherit version;
    src = source;
    deps = callPackage (source + "/build.zig.zon.nix") {
      name = "ghostty-cache-${finalAttrs.version}";
    };
    patches = map (name: patchDirectory + "/${name}") patchNames;
    doCheck = false;
    doInstallCheck = false;
  }
)
