{ lib, self, ... }:
{
  _class = "flake";

  perSystem =
    {
      pkgs,
      self',
      system,
      ...
    }:
    let
      inherit (pkgs) stdenv;
      inherit (stdenv.hostPlatform) isLinux;
    in
    {
      checks = {
        inherit (self'.packages)
          ai-tools
          farstep
          dotfiles-workstation
          equicord-settings
          theme-run
          ;
      }
      // lib.attrsets.optionalAttrs isLinux {
        hyper-window-tiling = self'.packages.hyper-window-tiling-gnome;
        toshy-runtime = self'.packages.toshy-runtime;
      }
      // lib.attrsets.optionalAttrs (system == "x86_64-linux") {
        nixos = self.nixosConfigurations.nixos.config.system.build.toplevel;
      };
    };
}
