{
  stdenv,
  lib,
  autoPatchelfHook,
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
  fallowPackage =
    {
      x86_64-linux = "@fallow-cli/linux-x64-gnu@3.9.1";
      aarch64-linux = "@fallow-cli/linux-arm64-gnu@3.9.1";
    }
    .${stdenv.hostPlatform.system} or null;

  patchFallow =
    package:
    stdenv.mkDerivation {
      pname = "fallow-cli-patched";
      version = "3.9.1";
      dontUnpack = true;

      nativeBuildInputs = [ autoPatchelfHook ];
      buildInputs = [ stdenv.cc.cc.lib ];

      installPhase = ''
        runHook preInstall
        cp -r ${package}/. "$out"
        chmod -R u+w "$out"
        runHook postInstall
      '';
    };

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
    overrides = lib.optionalAttrs (fallowPackage != null) {
      "${fallowPackage}" = patchFallow;
    };
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

    # autoPatchelf deliberately changes Fallow's published executable.
    FALLOW_SKIP_BINARY_VERIFY = "1";

    postUnpack = ''
      sourceRoot="$sourceRoot/packages/hyper-window-tiling"
    '';

    nativeBuildInputs = [
      bun
      bun2nix.hook
    ];

    buildPhase = buildPhaseFor "check";

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
