{ inputs }:
let
  lib = inputs.nixpkgs.lib;

  dependencies =
    _: prev:
    let
      unstable = import inputs.nixpkgs-unstable {
        localSystem = prev.stdenvNoCC.hostPlatform;
        inherit (prev) config;
      };
      eupkgsScope =
        unstable
        // eupkgsOverlay
        // {
          callPackage = unstable.lib.callPackageWith eupkgsScope;
        };
      eupkgsOverlay = inputs.eupkgs.overlays.default eupkgsScope unstable;
      eupkgs = removeAttrs eupkgsOverlay [ "_internalCallByNamePackageFile" ];
    in
    {
      inherit eupkgs unstable;
    };

  packageDefinitions =
    final: prev:
    let
      dotfilesSourcePins = import ../npins;
    in
    {
      inherit dotfilesSourcePins;
      bluebuild-v2 = final.callPackage ../packages/bluebuild-v2.nix {
        src = dotfilesSourcePins.bluebuild-cli.outPath;
        version =
          let
            manifest = fromTOML (builtins.readFile "${dotfilesSourcePins.bluebuild-cli.outPath}/Cargo.toml");
          in
          "${manifest.workspace.package.version}-unstable-${
            lib.substring 0 8 dotfilesSourcePins.bluebuild-cli.revision
          }";
      };
      bun2nix = inputs.bun2nix.packages.${final.stdenv.hostPlatform.system}.default;
      gh = final.unstable.gh;
      lldb-mcp-launcher = final.eupkgs.lldb-mcp-launcher;
      ghidra-mcp-headless = final.eupkgs.ghidra-mcp-headless;
      ghidra-mcp = final.callPackage ../packages/ghidra-mcp.nix {
        inherit (final) ghidra-mcp-headless;
      };
      ghostty-patched = final.callPackage ../packages/ghostty-patched.nix {
        ghostty = final.unstable.ghostty.override {
          zig_0_15 = final.unstable.zig;
        };
      };
      kanata-with-cmd = (final.kanata.override { withCmd = true; }).overrideAttrs {
        doCheck = false;
        doInstallCheck = false;
      };
      kmscon = prev.kmscon.overrideAttrs (
        _: previousAttrs: {
          # The pin follows upstream main rather than a release tag.
          version = "10.0.1-unstable-2026-07-31";
          src = dotfilesSourcePins.kmscon.outPath;
          buildInputs = previousAttrs.buildInputs ++ [ final.dbus ];
          mesonFlags = (previousAttrs.mesonFlags or [ ]) ++ [ "-Dtests=false" ];
          doCheck = false;
          # 10.0.1 installs kmscon itself as an ELF binary; nixpkgs'
          # 10.0.0 fixup still tries to rewrite it as a shell script.
          postFixup = ''
            substituteInPlace $out/bin/kmscon-launch-gui \
              --replace-fail "inotifywait" "${final.lib.getExe' final.inotify-tools "inotifywait"}"
          '';
        }
      );
      hyper-window-tiling = final.callPackage ../packages/hyper-window-tiling.nix { };
      hyper-window-tiling-gnome = final.hyper-window-tiling.gnome;
      hyper-window-tiling-kde = final.hyper-window-tiling.kde;
      dotfiles-python = final.callPackage ../packages/dotfiles-python.nix {
        inherit (final.unstable) python314Packages;
      };
      uresourced = final.callPackage ../packages/uresourced.nix {
        source = dotfilesSourcePins.uresourced.outPath;
        version = lib.removePrefix "v" dotfilesSourcePins.uresourced.version;
      };
      terminal-theme-tools = final.callPackage ../packages/terminal-theme-tools { };
    };

  packages = lib.composeManyExtensions [
    dependencies
    packageDefinitions
  ];
in
{
  inherit dependencies packages;
  default = packages;
}
