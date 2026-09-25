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
      inherit (final.unstable) python314;
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
