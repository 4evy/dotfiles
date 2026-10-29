{ lib, platform }:
let
  caches = builtins.filter (cache: !(cache ? platforms) || builtins.elem platform cache.platforms) (
    lib.importJSON ../../../data/nix/caches.json
  );
in
{
  extra-substituters = map (cache: cache.url) caches;
  extra-trusted-public-keys = map (cache: cache.key) caches;
}
