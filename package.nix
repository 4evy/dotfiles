{
  lib,
  stdenvNoCC,
  bun,
  bun2nix,
  makeBinaryWrapper,
  dotfilesPackageUpdaters,
}:
let
  root = ./.;
  entrypoints = (lib.trivial.importJSON ./package.json).bin;
in
stdenvNoCC.mkDerivation {
  name = "dotfiles-typescript-tools";
  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions (
      [
        ./package.json
        ./bun.lock
        ./home/package.json
        ./tools/workstation/package.json
        ./tools/tiling/package.json
        ./tools/tiling/vendor/fallow
        ./lib/typescript
        ./home/files/.local/lib/package.json
        ./home/files/.local/lib/typescript/process.ts
        ./home/files/.local/lib/typescript/runtime.ts
        ./Brewfile
        ./data/homebrew/tools.json
        ./data/rustdesk/options.json
        ./data/macos/permissions.json
        ./systems/modules/darwin/cli.ts
        ./systems/modules/darwin/permissions
      ]
      ++ map (path: root + "/${path}") (lib.attrsets.attrValues entrypoints)
    );
  };
  bunDeps = import ./nix/lib/bun/dependencies.nix { inherit lib bun2nix; };
  nativeBuildInputs = [
    bun
    bun2nix.hook
    makeBinaryWrapper
  ];
  strictDeps = true;
  dontRunLifecycleScripts = true;
  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;
  bunInstallFlags = [
    "--frozen-lockfile"
    "--offline"
    "--production"
    "--linker=hoisted"
    "--backend=copyfile"
  ];

  buildPhase = ''
    runHook preBuild
    mkdir -p "$out/libexec" "$out/bin"
    ${lib.strings.concatMapAttrsStringSep "\n" (name: source: ''
      bun build --target=bun --format=esm --minify \
        --outfile="$out/libexec/${name}.js" ${lib.strings.escapeShellArg source}
      makeWrapper ${lib.meta.getExe bun} "$out/bin/${name}" \
        --add-flag "$out/libexec/${name}.js" \
        --set-default DOTFILES_REPO "$out/share/dotfiles"
    '') entrypoints}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 Brewfile "$out/share/dotfiles/Brewfile"
    install -Dm644 data/homebrew/tools.json "$out/share/dotfiles/data/homebrew/tools.json"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    ${lib.strings.concatMapStringsSep "\n" (name: ''"$out/bin/${name}" --help'') (
      lib.attrsets.attrNames entrypoints
    )}
    runHook postInstallCheck
  '';

  passthru.updateScript = dotfilesPackageUpdaters.localWorkspace;

  meta = {
    description = "Bundled Effect-native activation and hardware tools";
    license = lib.licenses.mit;
    platforms = [
      "aarch64-darwin"
      "x86_64-linux"
    ];
  };
}
