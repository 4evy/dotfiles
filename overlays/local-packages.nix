{ inputs, lib }:
final: _prev:
let
  packageFiles = {
    bluebuild-v2 = ../packages/bluebuild-v2/package.nix;
    dotfiles-python = ../packages/dotfiles-python/package.nix;
    hyper-window-tiling = ../packages/hyper-window-tiling/package.nix;
    theme-run = ../packages/theme-run/package.nix;
    toshy-runtime = ../packages/toshy-runtime/package.nix;
    uresourced = ../packages/uresourced/package.nix;
  };

  packageArgs = {
    toshy-runtime = {
      # Toshy replaces packageOverrides, so extend its interpreter's package set
      # before applying upstream's pins without affecting other Python runtimes
      inherit
        (final.unstable.extend (
          _final: prev: {
            pythonPackagesExtensions = prev.pythonPackagesExtensions ++ [
              (_pyFinal: pyPrev: {
                # Concurrent X11 sync calls can consume each other's replies
                # Serialize request/reply pairs while keeping checks enabled
                i3ipc = pyPrev.i3ipc.overridePythonAttrs (old: {
                  patches = (old.patches or [ ]) ++ [
                    ../packages/toshy-runtime/i3ipc-sync-lock.patch
                  ];
                });
              })
            ];
          }
        ))
        python314
        ;
    };
    dotfiles-python = {
      inherit (final.unstable) python314Packages;
    };
  };

  packages = lib.mapAttrs (
    name: file: final.callPackage file (packageArgs.${name} or { })
  ) packageFiles;
in
packages
// {
  bun2nix = inputs.bun2nix.packages.${final.stdenv.hostPlatform.system}.default;
  gh = final.unstable.gh;
  hyper-window-tiling-gnome = final.hyper-window-tiling.gnome;
  hyper-window-tiling-kde = final.hyper-window-tiling.kde;
}
