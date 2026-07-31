{
  stdenv,
  lib,
  bun,
  bun2nix,
  glib,
}:
let
  repositoryRoot = ../.;
  packageRoot = ./hyper-window-tiling;
  packageMetadata = builtins.fromJSON (builtins.readFile (packageRoot + /package.json));
  gnomeMetadata = builtins.fromJSON (builtins.readFile (packageRoot + /gnome/metadata.json));
  kdeMetadata = builtins.fromJSON (builtins.readFile (packageRoot + /kde/metadata.json));
  inherit (packageMetadata) version;
  extensionUuid = gnomeMetadata.uuid;
  pluginId = kdeMetadata.KPlugin.Id;

  src = lib.fileset.toSource {
    root = repositoryRoot;
    fileset = lib.fileset.unions [
      (packageRoot + /bun.lock)
      (packageRoot + /gnome/metadata.json)
      (packageRoot + /gnome/schemas)
      (packageRoot + /kde/metadata.json)
      (packageRoot + /package.json)
      (packageRoot + /src)
      (packageRoot + /tsconfig.json)
    ];
  };

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./hyper-window-tiling/bun.nix;
  };

  buildPhaseFor = script: ''
    runHook preBuild

    bun run ${script}

    runHook postBuild
  '';

  workspaceCheck = stdenv.mkDerivation {
    pname = "hyper-window-tiling-workspace-check";
    inherit version src bunDeps;
    strictDeps = true;

    postUnpack = ''
      sourceRoot="$sourceRoot/packages/hyper-window-tiling"
    '';

    nativeBuildInputs = [
      bun
      bun2nix.hook
    ];

    # Fallow's changed-file audit needs a Git checkout and runs in bun.yaml.
    buildPhase = ''
      runHook preBuild

      bun run test
      bun run build
      bun run check:dist

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      touch "$out"
      runHook postInstall
    '';

    doCheck = false;
    doInstallCheck = false;
  };
in
{
  gnome = stdenv.mkDerivation {
    pname = "gnome-shell-extension-hyper-window-tiling";
    inherit version src;
    strictDeps = true;

    postUnpack = ''
      sourceRoot="$sourceRoot/packages/hyper-window-tiling"
    '';

    nativeBuildInputs = [
      bun
      bun2nix.hook
      glib
    ];
    inherit bunDeps;

    buildPhase = buildPhaseFor "build:gnome";

    installPhase = ''
      runHook preInstall

      extension_dir="$out/share/gnome-shell/extensions/${extensionUuid}"
      install -d "$extension_dir" "$extension_dir/schemas"
      install -m0644 gnome/metadata.json "$extension_dir/metadata.json"
      install -m0644 dist/gnome/extension.js "$extension_dir/extension.js"
      install -m0644 gnome/schemas/*.xml "$extension_dir/schemas"
      glib-compile-schemas "$extension_dir/schemas"

      runHook postInstall
    '';

    doCheck = false;
    doInstallCheck = false;

    passthru = {
      inherit extensionUuid;
      tests.workspace = workspaceCheck;
    };

    meta = {
      description = "Hyper-key window tiling extension for GNOME Shell";
      license = lib.licenses.mit;
      platforms = lib.platforms.linux;
    };
  };

  kde = stdenv.mkDerivation {
    pname = "kwin-script-hyper-window-tiling";
    inherit version src;
    strictDeps = true;

    postUnpack = ''
      sourceRoot="$sourceRoot/packages/hyper-window-tiling"
    '';

    nativeBuildInputs = [
      bun
      bun2nix.hook
    ];
    inherit bunDeps;

    buildPhase = buildPhaseFor "build:kde";

    installPhase = ''
      runHook preInstall

      script_dir="$out/share/kwin-wayland/scripts/${pluginId}"
      install -d "$script_dir/contents/code"
      install -m0644 kde/metadata.json "$script_dir/metadata.json"
      install -m0644 dist/kde/contents/code/main.js "$script_dir/contents/code/main.js"

      runHook postInstall
    '';

    doCheck = false;
    doInstallCheck = false;

    passthru.pluginId = pluginId;

    meta = {
      description = "Hyper-key window tiling script for KDE Plasma";
      license = lib.licenses.mit;
      platforms = lib.platforms.linux;
    };
  };
}
