{
  lib,
  rustPlatform,
  src,
  version,
}:
rustPlatform.buildRustPackage {
  pname = "bluebuild";
  inherit version src;

  cargoLock.lockFile = "${src}/Cargo.lock";
  buildFeatures = [ "recipe-v2" ];
  doCheck = false;

  meta = {
    description = "BlueBuild CLI with the feature-gated recipe v2 parser";
    homepage = "https://github.com/blue-build/cli";
    license = lib.licenses.asl20;
    mainProgram = "bluebuild";
    platforms = lib.platforms.linux;
  };
}
