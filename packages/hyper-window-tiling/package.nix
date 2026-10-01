{
  stdenv,
  lib,
  bun,
  bun2nix,
  glib,
}:
let
  repositoryRoot = ../..;
  packageRoot = ./.;
  packageMetadata = lib.importJSON (packageRoot + /package.json);
  gnomeMetadata = lib.importJSON (packageRoot + /gnome/metadata.json);
  kdeMetadata = lib.importJSON (packageRoot + /kde/metadata.json);
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
    bunNix = ./bun.nix;
  };

  buildPhaseFor = script: ''
    runHook preBuild

    bun run ${script}

    runHook postBuild
  '';

  mkTilingExtension = lib.extendMkDerivation {
    constructDrv = stdenv.mkDerivation;
    extendDrvArgs = _: args: {
      inherit version src bunDeps;
      strictDeps = true;

      postUnpack = ''
        sourceRoot="$sourceRoot/packages/hyper-window-tiling"
      '';

      nativeBuildInputs = [
        bun
        bun2nix.hook
      ]
      ++ (args.nativeBuildInputs or [ ]);
      doCheck = false;
      doInstallCheck = false;

      meta = {
        homepage = "https://github.com/4evy/dotfiles";
        license = lib.licenses.mit;
        maintainers = [ lib.maintainers._4evy ];
        platforms = lib.platforms.linux;
      }
      // (args.meta or { });
    };
  };

in
{
  gnome = mkTilingExtension {
    pname = "gnome-shell-extension-hyper-window-tiling";
    nativeBuildInputs = [ glib ];

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

    passthru = { inherit extensionUuid; };

    meta = {
      description = "Hyper-key window tiling extension for GNOME Shell";
    };
  };

  kde = mkTilingExtension {
    pname = "kwin-script-hyper-window-tiling";

    buildPhase = buildPhaseFor "build:kde";

    installPhase = ''
      runHook preInstall

      script_dir="$out/share/kwin/scripts/${pluginId}"
      install -d "$script_dir/contents/code"
      install -m0644 kde/metadata.json "$script_dir/metadata.json"
      install -m0644 dist/kde/contents/code/main.js "$script_dir/contents/code/main.js"

      runHook postInstall
    '';

    passthru.pluginId = pluginId;

    meta = {
      description = "Hyper-key window tiling script for KDE Plasma";
    };
  };
}
