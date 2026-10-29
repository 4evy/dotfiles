{
  lib,
  stdenvNoCC,
  bun,
  bun2nix,
  makeBinaryWrapper,
}:
let
  root = ./.;
  entrypoints = (lib.importJSON ./package.json).bin;
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
        ./Brewfile
        ./data/homebrew/tools.json
        ./data/rustdesk/options.json
      ]
      ++ map (path: root + "/${path}") (lib.attrValues entrypoints)
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
    ${lib.concatStringsSep "\n" (
      lib.mapAttrsToList (name: source: ''
        bun build --target=bun --format=esm --minify \
          --outfile="$out/libexec/${name}.js" ${lib.escapeShellArg source}
        makeWrapper ${lib.getExe bun} "$out/bin/${name}" \
          --add-flag "$out/libexec/${name}.js" \
          --set-default DOTFILES_REPO "$out/share/dotfiles"
      '') entrypoints
    )}
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
    ${lib.concatMapStringsSep "\n" (name: ''"$out/bin/${name}" --help'') (lib.attrNames entrypoints)}
    runHook postInstallCheck
  '';

  meta = {
    description = "Bundled Effect-native activation and hardware tools";
    license = lib.licenses.mit;
    platforms = [
      "aarch64-darwin"
      "x86_64-linux"
    ];
  };
}
