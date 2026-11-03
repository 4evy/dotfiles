{
  lib,
  stdenvNoCC,
  fetchFromGitHub,
  callPackage,
  git,
  gettext,
  makeWrapper,
  pandoc,
  zig_0_17,
  patchesSource,
}:
let
  manifest = lib.importJSON (patchesSource + "/stacks/ghostty/stack.json");
  revision = manifest.source.revision;
  source = fetchFromGitHub {
    owner = "ghostty-org";
    repo = "ghostty";
    rev = revision;
    hash = "sha256-ywmIjwix0P5TC8kD/zTmt82CNrLXMFETaWZj0NirpoM=";
  };
  patchRoot = patchesSource + "/stacks/ghostty/patches";
  patches = lib.map (name: patchRoot + "/${name}") (
    lib.filter (name: name != "" && !(lib.hasPrefix "#" name)) (
      lib.splitString "\n" (lib.readFile (patchRoot + "/series"))
    )
  );
  dependencies = callPackage (source + "/build.zig.zon.nix") {
    name = "ghostty-zig17-packages";
  };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "ghostty-patched";
  version = "1.4.0+patched.${lib.substring 0 7 revision}";
  src = source;
  inherit patches;

  nativeBuildInputs = lib.attrValues {
    inherit
      git
      gettext
      makeWrapper
      pandoc
      zig_0_17
      ;
  };
  # The macOS frontend is built with Apple's installed Xcode toolchain
  __noChroot = true;
  dontConfigure = true;
  dontFixup = true;

  postPatch = ''
    export HOME="$TMPDIR/home"
    export ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-cache"
    mkdir -p "$HOME" "$ZIG_GLOBAL_CACHE_DIR/tmp"
    # Xcode's component shim cannot discover Metal for Nix's build users
    substituteInPlace src/build/MetallibStep.zig \
      --replace-fail 'const sdk = switch' '_ = switch' \
      --replace-fail '"/usr/bin/xcrun", "-sdk", sdk, "metal"' \
        '"/Library/Developer/Toolchains/Metal.xctoolchain/usr/bin/metal"' \
      --replace-fail '"/usr/bin/xcrun", "-sdk", sdk, "metallib"' \
        '"/Library/Developer/Toolchains/Metal.xctoolchain/usr/bin/metallib"'
  '';

  buildPhase = ''
    runHook preBuild
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
    export SDKROOT=$(/usr/bin/xcrun --sdk macosx --show-sdk-path)
    # Ghostty forwards only PATH to Xcode, so restore its writable home here
    # Apple's Swift macro sandbox fails under Nix's build users
    mkdir -p "$TMPDIR/xcode-bin"
    makeWrapper /usr/bin/xcodebuild "$TMPDIR/xcode-bin/xcodebuild" \
      --set HOME "$HOME" --set CFFIXED_USER_HOME "$HOME" \
      --set DEVELOPER_DIR "$DEVELOPER_DIR" \
      --set NIX_BUILD_CORES "$NIX_BUILD_CORES" \
      --run 'if [ "$1" != -create-xcframework ]; then
        set -- -jobs "$NIX_BUILD_CORES" \
          "OTHER_SWIFT_FLAGS=\$(inherited) -disable-sandbox" "$@"
      fi' --run 'exec > "$HOME/xcodebuild.$$.log" 2>&1'
    export PATH="$TMPDIR/xcode-bin:$PATH"
    export PATH="$PATH:/usr/bin:/bin:/usr/sbin:/sbin"
    if ! zig build -j"$NIX_BUILD_CORES" \
      --system ${dependencies} \
      -Doptimize=fast -Demit-test-exe=false \
      -Dxcframework-target=native \
      -Dxcodebuild-disable-package-manifest-sandbox=true \
      -Dversion-string=${lib.escapeShellArg finalAttrs.version}; then
      for log in "$HOME"/xcodebuild.*.log; do
        if [ -f "$log" ]; then
          cat "$log" >&2
        fi
      done
      exit 1
    fi
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/Applications" "$out/bin"
    cp -R zig-out/Ghostty.app "$out/Applications/Ghostty.app"
    makeWrapper "$out/Applications/Ghostty.app/Contents/MacOS/ghostty" "$out/bin/ghostty"
    runHook postInstall
  '';

  passthru = { inherit dependencies; };
  meta = {
    description = "Ghostty built with the 4evy patch stack";
    homepage = "https://ghostty.org";
    license = lib.licenses.mit;
    mainProgram = "ghostty";
    platforms = [ "aarch64-darwin" ];
  };
})
