{
  dotfilesSourcePins,
  lib,
  rustPlatform,
}:
let
  sourcePin = dotfilesSourcePins.bluebuild-cli;
  src = sourcePin.outPath;
  manifest = lib.importTOML (src + "/Cargo.toml");
  version = "${manifest.workspace.package.version}-unstable-${lib.substring 0 8 sourcePin.revision}";
in
rustPlatform.buildRustPackage {
  pname = "bluebuild";
  inherit version src;

  # Forward switch's validation policy to its internal Containerfile generator
  postPatch = ''
    substituteInPlace src/commands/switch.rs \
      --replace-fail '.recipe(&self.recipe)' \
        '.recipe(&self.recipe).skip_validation(self.skip_validation)'
    # Keep explicit drivers from evaluating unused runtime autodetection
    substituteInPlace process/drivers/types/drivers.rs \
      --replace-fail '*self.get_or_insert(' '*self.get_or_insert_with(||'
  '';

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
