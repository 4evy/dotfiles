{ lib }:
let
  cacheSettings = import ../cache/settings.nix {
    inherit lib;
    platform = "spectrum";
  };
  defaults = import ../gnome/defaults.nix { inherit lib; };
in
{
  nixCustomConf = ''
    # Spectrum overrides for the installer-managed Determinate Nix daemon
    builders-use-substitutes = true
    extra-experimental-features = parallel-eval
    extra-substituters = ${lib.concatStringsSep " " cacheSettings.extra-substituters}
    extra-trusted-public-keys = ${lib.concatStringsSep " " cacheSettings.extra-trusted-public-keys}
  '';
  dconf = lib.generators.toDconfINI (
    defaults
    // {
      "org/gnome/mutter".overlay-key = "Super_L";
    }
  );
}
