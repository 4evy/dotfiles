{ inputs, ... }:
{
  _class = null;

  nixpkgs = {
    config.allowUnfree = true;
    overlays = [
      (
        final: prev:
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
          inherit unstable eupkgs;
        }
      )
      (
        final: prev:
        let
          goWorkspacePackage = final.callPackage ../../packages/go-workspace-package.nix { };
        in
        {
          gh = final.unstable.gh;
          lldb-mcp-launcher = final.eupkgs.lldb-mcp-launcher;
          ghidra-mcp-headless = final.eupkgs.ghidra-mcp-headless;
          ghidra-mcp = final.callPackage ../../packages/ghidra-mcp.nix {
            inherit (final) ghidra-mcp-headless;
          };
          kanata = prev.kanata;
          kanata-with-cmd = final.kanata.override { withCmd = true; };
          hyper-window-tiling = final.callPackage ../../packages/hyper-window-tiling.nix { };
          hyper-window-tiling-gnome = final.hyper-window-tiling.gnome;
          hyper-window-tiling-kde = final.hyper-window-tiling.kde;
          dotfiles-python = final.callPackage ../../packages/dotfiles-python.nix {
            inherit (final.unstable) python314Packages;
          };
          system-runner = final.writeScriptBin "system-runner" ''
            #!${final.python3}/bin/python3
            ${builtins.readFile ../../ansible/files/scripts/workstation/local/system_runner.py}
          '';
          terminal-theme-tools = goWorkspacePackage {
            pname = "terminal-theme-tools";
            subPackages = [ "cmd/terminal-theme-run" ];
            meta = {
              description = "Theme-aware wrappers for terminal applications";
              mainProgram = "terminal-theme-run";
              platforms = final.lib.platforms.linux;
            };
          };
        }
      )
    ];
  };
}
