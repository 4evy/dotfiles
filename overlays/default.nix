{ inputs }:
let
  lib = inputs.nixpkgs.lib;

  dependencies =
    _: prev:
    let
      unstable = import inputs.nixpkgs-unstable {
        inherit (prev.stdenvNoCC.hostPlatform) system;
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
      dotfilesSources = (builtins.fromJSON (builtins.readFile ../manifests/sources.json)).sources;
    in
    {
      inherit dotfilesSources;
      gh = final.unstable.gh;
      lldb-mcp-launcher = final.eupkgs.lldb-mcp-launcher;
      ghidra-mcp-headless = final.eupkgs.ghidra-mcp-headless;
      ghidra-mcp = final.callPackage ../packages/ghidra-mcp.nix {
        inherit (final) ghidra-mcp-headless;
      };
      kanata = prev.kanata;
      kanata-with-cmd = (final.kanata.override { withCmd = true; }).overrideAttrs {
        doCheck = false;
        doInstallCheck = false;
      };
      kmscon = prev.kmscon.overrideAttrs (
        _: previousAttrs: {
          inherit (dotfilesSources.kmscon) version;
          src = final.fetchFromGitHub {
            owner = dotfilesSources.kmscon.repository.owner;
            repo = dotfilesSources.kmscon.repository.name;
            rev = dotfilesSources.kmscon.revision;
            hash = dotfilesSources.kmscon.hashes.nix_source;
          };
          buildInputs = previousAttrs.buildInputs ++ [ final.dbus ];
          doCheck = false;
          doInstallCheck = false;
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
      # Keep the privileged command on the same packaged entry point as
      # every other repository automation command. Copying its module into
      # a standalone script loses the Python dependency environment.
      system-runner = final.dotfiles-python;
      tomlc17 = prev.tomlc17.overrideAttrs {
        inherit (dotfilesSources.tomlc17) version;
        src = final.fetchFromGitHub {
          owner = dotfilesSources.tomlc17.repository.owner;
          repo = dotfilesSources.tomlc17.repository.name;
          rev = dotfilesSources.tomlc17.revision;
          hash = dotfilesSources.tomlc17.hashes.nix_source;
        };
      };
      uresourced = final.callPackage ../packages/uresourced.nix {
        sourcePin = dotfilesSources.uresourced;
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
