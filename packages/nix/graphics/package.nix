{
  lib,
  stdenvNoCC,
  fetchFromGitHub,
  unstable,
  patchelf,
}:
stdenvNoCC.mkDerivation {
  pname = "nix-gl-host";
  version = "0.1-unstable-2024-11-21";
  src = fetchFromGitHub {
    owner = "numtide";
    repo = "nix-gl-host";
    rev = "5269b233f83880a0b433eafe026f0bc0d8f1a4a9";
    hash = "sha256-QZCKJoypcwgS3tDNSWMjlxEBZtOYPW3eXV24rMzKsac=";
  };
  buildInputs = lib.attrValues { inherit (unstable) python315; };
  nativeCheckInputs = lib.attrValues { inherit (unstable) python315; };
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
      --replace-fail '@patchelf-bin@' '${lib.getExe patchelf}' \
      --replace-fail 'IN_NIX_STORE = False' 'IN_NIX_STORE = True'
    runHook postInstall
  '';
  meta = {
    description = "Expose host NVIDIA graphics libraries to Nix applications";
    homepage = "https://github.com/numtide/nix-gl-host";
    license = lib.licenses.asl20;
    mainProgram = "nixglhost";
    platforms = lib.platforms.linux;
  };
}
