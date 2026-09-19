{
  dotfilesSourcePins,
  lib,
  rustPlatform,
}:
let
  sourcePin = dotfilesSourcePins.bluebuild-cli;
  src = sourcePin.outPath;
  manifest = fromTOML (builtins.readFile (src + "/Cargo.toml"));
  version = "${manifest.workspace.package.version}-unstable-${lib.substring 0 8 sourcePin.revision}";
in
rustPlatform.buildRustPackage {
  pname = "bluebuild";
  inherit version src;

  cargoLock.lockFile = "${src}/Cargo.lock";
  buildFeatures = [
    "bootc"
    "recipe-v2"
  ];
  doCheck = false;
  doInstallCheck = false;

  meta = {
    description = "BlueBuild CLI with bootc and the feature-gated recipe v2 parser";
    homepage = "https://github.com/blue-build/cli";
    license = lib.licenses.asl20;
    mainProgram = "bluebuild";
    platforms = lib.platforms.linux;
  };
}
