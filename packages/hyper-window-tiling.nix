{
  stdenv,
  lib,
  bun,
  glib,
  writableTmpDirAsHomeHook,
}:
let
  repositoryRoot = ../.;
  packageRoot = ./hyper-window-tiling;
  packageMetadata = builtins.fromJSON (builtins.readFile (packageRoot + /package.json));
  gnomeMetadata = builtins.fromJSON (builtins.readFile (packageRoot + /gnome/metadata.json));
  kdeMetadata = builtins.fromJSON (builtins.readFile (packageRoot + /kde/metadata.json));
  inherit (packageMetadata) version;
  pname = packageMetadata.name;
  extensionUuid = gnomeMetadata.uuid;
  pluginId = kdeMetadata.KPlugin.Id;

  src = lib.fileset.toSource {
    root = repositoryRoot;
    fileset = lib.fileset.unions [
      (repositoryRoot + /bun.lock)
      (repositoryRoot + /package.json)
      (repositoryRoot + /dotfiles/package.json)
      (packageRoot + /gnome/metadata.json)
      (packageRoot + /gnome/schemas)
      (packageRoot + /kde/metadata.json)
      (packageRoot + /package.json)
      (packageRoot + /src)
      (packageRoot + /tsconfig.json)
    ];
  };

  nodeModulesHash = {
    "x86_64-linux" = "sha256-RhXJXYE15AcDU8uz6HLF6KY0gupXok4jzyxH2R6DXok=";
  };
  bunOS = "linux";
  bunCPU =
    {
      "aarch64" = "arm64";
      "x86_64" = "x64";
    }
    .${stdenv.hostPlatform.parsed.cpu.name}
      or (throw "${pname}: unsupported Bun CPU ${stdenv.hostPlatform.parsed.cpu.name}");

  node_modules = stdenv.mkDerivation {
    pname = "${pname}-node_modules";
    inherit version src;
    strictDeps = true;

    postUnpack = ''
      sourceRoot="$sourceRoot/packages/hyper-window-tiling"
    '';

    impureEnvVars = lib.fetchers.proxyImpureEnvVars ++ [
      "GIT_PROXY_COMMAND"
      "SOCKS_SERVER"
    ];

    nativeBuildInputs = [
      bun
      writableTmpDirAsHomeHook
    ];

    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      runHook preBuild

      export BUN_INSTALL_CACHE_DIR=$(mktemp -d)
      bun install --no-progress --frozen-lockfile --filter ${pname} --backend=copyfile --os=${bunOS} --cpu=${bunCPU}

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      cp -R ../../node_modules $out/node_modules

      runHook postInstall
    '';

    outputHash =
      nodeModulesHash.${stdenv.hostPlatform.system}
        or (throw "${pname}: Bun node_modules hash is not packaged for ${stdenv.hostPlatform.system}");
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    doCheck = false;
    doInstallCheck = false;
  };

  buildPhaseFor = script: ''
    runHook preBuild

    cp -R ${node_modules}/node_modules ../../node_modules
    patchShebangs ../../node_modules
    bun run ${script}

    runHook postBuild
  '';
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
      glib
    ];

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

    passthru.extensionUuid = extensionUuid;

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
    ];

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
