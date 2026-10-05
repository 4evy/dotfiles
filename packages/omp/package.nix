{
  lib,
  stdenv,
  fetchzip,
  bun,
  bun2nix,
  autoPatchelfHook,
  makeWrapper,
  zstd,
}:
let
  source = lib.importJSON ./source.json;
in
stdenv.mkDerivation {
  pname = "omp-runtime";
  inherit (source) version;
  src = fetchzip {
    inherit (source) url hash;
    extension = "tar.gz";
  };

  patches =
    map (name: ./patches + "/${name}") (
      builtins.attrNames (
        lib.filterAttrs (name: type: type == "regular" && lib.hasSuffix ".patch" name) (
          builtins.readDir ./patches
        )
      )
    )
    ++ [
      ./broker-environment.patch
      ./immutable-update.patch
    ];

  bunDeps = bun2nix.fetchBunDeps { bunNix = ./upstream/bun.nix; };
  nativeBuildInputs = [
    bun
    bun2nix.hook
    autoPatchelfHook
    makeWrapper
  ];
  buildInputs = [ stdenv.cc.cc.lib ];
  strictDeps = true;
  dontRunLifecycleScripts = true;
  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;
  bunInstallFlags = [
    "--linker=hoisted"
    "--backend=copyfile"
  ];

  # Install the locked release dependency closure, not the upstream development
  # workspace, then restore its manifest alongside the complete patched sources
  postPatch = ''
    mv package.json source-package.json
    cp ${./upstream/package.json} package.json
    cp ${./upstream/bun.lock} bun.lock
  '';

  buildPhase = ''
    runHook preBuild
    mv source-package.json package.json
    bun packages/collab-web/scripts/build-tool-views.ts
    bun --cwd=packages/stats run gen:stats
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    runtime="$out/lib/omp-runtime"
    mkdir -p "$runtime" "$out/bin"
    cp -R . "$runtime/"
    chmod -R u+w "$runtime"

    # Bun installs both libc variants; this glibc-only package must not retain
    # optional musl libraries for autoPatchelf or runtime loading
    rm -rf \
      "$runtime/node_modules/@img/sharp-linuxmusl-x64" \
      "$runtime/node_modules/@img/sharp-libvips-linuxmusl-x64"

    # Every published workspace in the dependency closure resolves back into
    # this same patched source tree, including the SDK worker-host CLI fallback
    for manifest in "$runtime"/packages/*/package.json; do
      name=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).name)' "$manifest")
      case "$name" in
        @oh-my-pi/*)
          if [ -e "$runtime/node_modules/$name" ]; then
            rm -rf "$runtime/node_modules/$name"
            ln -s "$(dirname "$manifest")" "$runtime/node_modules/$name"
          fi
          ;;
      esac
    done
    test -f "$runtime/node_modules/@oh-my-pi/pi-natives-linux-x64/package.json"
    # Source-mode loading deliberately skips node_modules platform packages
    for addon in "$runtime/node_modules/@oh-my-pi/pi-natives-linux-x64/"*.node; do
      test -f "$addon"
      ln -s "$addon" "$runtime/packages/natives/native/$(basename "$addon")"
    done
    ln -sfn "$runtime/packages/coding-agent/src/cli.ts" \
      "$runtime/node_modules/.bin/omp"
    makeWrapper ${bun}/bin/bun "$out/bin/omp-runtime" \
      --add-flags "$runtime/packages/coding-agent/src/cli.ts" \
      --prefix PATH : "${lib.makeBinPath [ zstd ]}"
    ln -s omp-runtime "$out/bin/omp"
    runHook postInstall
  '';

  meta = {
    description = "Coherent patched omp broker source runtime and locked Linux addon";
    homepage = "https://github.com/can1357/oh-my-pi";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
    mainProgram = "omp";
  };
}
