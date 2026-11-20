{ lib, platform }:
let
  caches = lib.lists.filter (cache: !(cache ? platforms) || lib.lists.elem platform cache.platforms) (
    lib.trivial.importJSON ../../../data/nix/caches.json
  );
in
{
  extra-substituters = lib.lists.map (cache: cache.url) caches;
  extra-trusted-public-keys = lib.lists.map (cache: cache.key) caches;
}
