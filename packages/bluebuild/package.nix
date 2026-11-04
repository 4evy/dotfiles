{
  dotfilesSourcePins,
  lib,
  rustPlatform,
}:
let
  sourcePin = dotfilesSourcePins.bluebuild-cli;
  src = sourcePin.outPath;
  manifest = lib.importTOML (src + "/Cargo.toml");
  version = manifest.workspace.package.version;
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
  # Release sources include these features, but release installers omit them
  # The recipe therefore installs the all-features main-installer image
  buildFeatures = [
    "bootc"
    "recipe-v2"
  ];
  doCheck = false;
  doInstallCheck = false;

  passthru.updateScript = sourcePin.updateScript;

  meta = {
    description = "BlueBuild CLI with bootc and the feature-gated recipe v2 parser";
    homepage = "https://github.com/blue-build/cli";
    license = lib.licenses.asl20;
    mainProgram = "bluebuild";
    platforms = lib.platforms.linux;
  };
}
