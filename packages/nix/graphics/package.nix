{
  lib,
  stdenvNoCC,
  dotfilesSourcePins,
  unstable,
  patchelf,
}:
let
  sourcePin = dotfilesSourcePins.nix-gl-host;
  date = sourcePin.lastModifiedDate;
in
stdenvNoCC.mkDerivation {
  pname = "nix-gl-host";
  version = "0.1-unstable-${lib.strings.substring 0 4 date}-${lib.strings.substring 4 2 date}-${lib.strings.substring 6 2 date}";
  src = sourcePin.outPath;
  buildInputs = [ unstable.python315 ];
  nativeCheckInputs = [ unstable.python315 ];
  dontBuild = true;
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    python3.15 src/nixglhost_test.py
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 src/nixglhost.py "$out/bin/nixglhost"
    substituteInPlace "$out/bin/nixglhost" \
      --replace-fail '@patchelf-bin@' '${lib.meta.getExe patchelf}' \
      --replace-fail 'IN_NIX_STORE = False' 'IN_NIX_STORE = True'
    runHook postInstall
  '';
  passthru.updateScript = sourcePin.updateScript;
  meta = {
    description = "Expose host NVIDIA graphics libraries to Nix applications";
    homepage = "https://github.com/numtide/nix-gl-host";
    license = lib.licenses.asl20;
    mainProgram = "nixglhost";
    platforms = lib.systems.doubles.linux;
  };
}
