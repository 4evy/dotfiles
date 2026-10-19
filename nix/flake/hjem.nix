{
  inputs,
  lib,
  withSystem,
  ...
}:
{
  _class = "flake";

  flake.lib = {
    # Only public host paths cross the launcher's Nix boundary
    hjemHome =
      runtimeJSON:
      let
        runtime = lib.fromJSON runtimeJSON;
      in
      withSystem runtime.system (
        { pkgs, ... }:
        import ../../modules/hjem/home.nix {
          inherit pkgs inputs;
          inherit (runtime) environment;
        }
      );

    hjemConfiguration =
      runtimeJSON:
      withSystem "x86_64-linux" (
        { pkgs, self', ... }:
        let
          inherit (pkgs) callPackage writeText;
          runtime = lib.fromJSON runtimeJSON;
          configuration = import ../../modules/hjem {
            inherit pkgs;
            inherit (runtime) environment;
            packages = lib.attrValues {
              inherit (inputs.hjem.packages.x86_64-linux) hjem;
              inherit (self'.packages) dotfiles-nix-tools dotfiles-apps dotfiles-user-tools;
              chatgpt = callPackage ../../dotfiles/home/.local/share/nix/chatgpt/package.nix { };
            };
          };
        in
        writeText "hjem-configuration.nix" (lib.generators.toPretty { } configuration)
      );
  };

  perSystem = { system, pkgs, ... }: {
    packages.hjem = inputs.hjem.packages.${system}.hjem;
    packages.hjem-files = import ../../modules/hjem/home.nix { inherit pkgs inputs; };
  };
}
