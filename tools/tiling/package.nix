{
  stdenvNoCC,
  lib,
  bun,
  bun2nix,
  glib,
  dotfilesPackageUpdaters,
}:
let
  inherit (bun2nix) hook;
  packageRoot = ./.;
  packageMetadata = lib.trivial.importJSON (packageRoot + /package.json);
  gnomeMetadata = lib.trivial.importJSON (packageRoot + /gnome/metadata.json);
  kdeMetadata = lib.trivial.importJSON (packageRoot + /kde/metadata.json);
  inherit (packageMetadata) version;
  extensionUuid = gnomeMetadata.uuid;
  pluginId = kdeMetadata.KPlugin.Id;

  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ../../package.json
      ../../bun.lock
      ../../home/package.json
      ../../home/files/.local/lib/package.json
      ../../lib/typescript/package.json
      ../workstation/package.json
      (packageRoot + /bindings.json)
      (packageRoot + /gnome/metadata.json)
      (packageRoot + /kde/metadata.json)
      (packageRoot + /package.json)
      (packageRoot + /scripts)
      (packageRoot + /src)
      (packageRoot + /tsconfig.json)
      (packageRoot + /vendor)
    ];
  };

  bunDeps = import ../../nix/lib/bun/dependencies.nix { inherit lib bun2nix; };

  buildPhaseFor = script: ''
    runHook preBuild

    bun run --cwd tools/tiling ${script}

    runHook postBuild
  '';

  mkTilingExtension = lib.customisation.extendMkDerivation {
    # Both desktop extensions bundle JavaScript without a native compiler
    constructDrv = stdenvNoCC.mkDerivation;
    extendDrvArgs = _: args: {
      inherit version src bunDeps;
      strictDeps = true;
      bunInstallFlags = [
        "--frozen-lockfile"
        "--offline"
        "--filter=@dotfiles/tiling"
      ];

      nativeBuildInputs =
        lib.attrsets.attrValues {
          inherit bun hook;
        }
        ++ (args.nativeBuildInputs or [ ]);
      doCheck = false;
      doInstallCheck = false;
      passthru = (args.passthru or { }) // {
        updateScript = dotfilesPackageUpdaters.localWorkspace;
      };

      meta = {
        homepage = "https://github.com/4evy/dotfiles";
        license = lib.licenses.mit;
        maintainers = [ lib.maintainers._4evy ];
        platforms = lib.systems.doubles.linux;
      }
      // (args.meta or { });
    };
  };

in
{
  gnome = mkTilingExtension {
    pname = "gnome-shell-extension-hyper-window-tiling";
    nativeBuildInputs = lib.attrsets.attrValues { inherit glib; };

    buildPhase = buildPhaseFor "build:gnome";

    installPhase = ''
      runHook preInstall
      cd tools/tiling

      extension_dir="$out/share/gnome-shell/extensions/${extensionUuid}"
      install -d "$extension_dir" "$extension_dir/schemas"
      install -m0644 gnome/metadata.json "$extension_dir/metadata.json"
      install -m0644 dist/gnome/extension.js "$extension_dir/extension.js"
      install -m0644 dist/gnome/schemas/*.xml "$extension_dir/schemas"
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
      cd tools/tiling

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
