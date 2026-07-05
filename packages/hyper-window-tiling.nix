{
  stdenv,
  lib,
  bun,
  glib,
  writableTmpDirAsHomeHook,
}:
let
  root = ./hyper-window-tiling;
  pluginId = "hyper-window-tiling";
  extensionUuid = "hyper-window-tiling@4evy.local";
  pname = "hyper-window-tiling";
  version = "1.0.0";

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + /bun.lock)
      (root + /gnome/metadata.json)
      (root + /gnome/schemas)
      (root + /kde/metadata.json)
      (root + /package.json)
      (root + /src)
      (root + /tsconfig.json)
    ];
  };

  nodeModulesHash = {
    "x86_64-linux" = "sha256-vtirCtBKF1HLTj9lwXxNef+AWXhY1Sl2SmnEZcK97ak=";
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
      bun install --no-progress --frozen-lockfile --backend=copyfile --os=${bunOS} --cpu=${bunCPU}

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      cp -R node_modules $out/node_modules

      runHook postInstall
    '';

    outputHash =
      nodeModulesHash.${stdenv.hostPlatform.system}
        or (throw "${pname}: Bun node_modules hash is not packaged for ${stdenv.hostPlatform.system}");
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };

  buildPhaseFor = script: ''
    runHook preBuild

    cp -R ${node_modules}/node_modules node_modules
    patchShebangs node_modules
    bun run ${script}

    runHook postBuild
  '';
in
{
  gnome = stdenv.mkDerivation {
    pname = "gnome-shell-extension-hyper-window-tiling";
    inherit version src;

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

    passthru.extensionUuid = extensionUuid;
  };

  kde = stdenv.mkDerivation {
    pname = "kwin-script-hyper-window-tiling";
    inherit version src;

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

    passthru.pluginId = pluginId;
  };
}
