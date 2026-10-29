{ lib, bun2nix }:
let
  # bun.nix copies workspace paths independently of each derivation's src
  # Keep runtime records and unrelated workspace files out of the cache
  # Workspace code comes from each package's src, not the dependency cache
  source = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../bun.nix
      ../../../lib/typescript/package.json
      ../../../home/package.json
      ../../../home/files/.local/lib/package.json
      ../../../tools/tiling/package.json
      ../../../tools/workstation/package.json
      ../../../tools/tiling/vendor/fallow
    ];
  };
in
bun2nix.fetchBunDeps { bunNix = "${source}/bun.nix"; }
