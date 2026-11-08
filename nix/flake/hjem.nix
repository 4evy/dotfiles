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
        runtime = builtins.fromJSON runtimeJSON;
      in
      withSystem runtime.system (
        { pkgs, ... }:
        import ../../home/deploy/nix/home.nix {
          inherit pkgs inputs;
          inherit (runtime) environment;
        }
      );

    hjemConfiguration =
      runtimeJSON:
      withSystem "x86_64-linux" (
        { pkgs, self', ... }:
        let
          inherit (pkgs) callPackage dotfilesPackageUpdaters writeText;
          runtime = builtins.fromJSON runtimeJSON;
          configuration = import ../../home/deploy/nix {
            inherit pkgs;
            inherit (runtime) environment;
            packages = lib.attrsets.attrValues {
              inherit (inputs.hjem.packages.x86_64-linux) hjem;
              inherit (self'.packages) dotfiles-nix-tools dotfiles-apps dotfiles-user-tools;
              chatgpt = callPackage ../../home/files/.local/share/nix/chatgpt/package.nix { };
            };
          };
        in
        (writeText "hjem-configuration.nix" (lib.generators.toPretty { } configuration)).overrideAttrs {
          passthru.updateScript = dotfilesPackageUpdaters.sequence "update-hjem-configuration" [
            (dotfilesPackageUpdaters.flakeInputs [ "hjem" ])
            dotfilesPackageUpdaters.localWorkspace
          ];
        }
      );
  };

  perSystem = { system, pkgs, ... }: {
    packages.hjem = inputs.hjem.packages.${system}.hjem.overrideAttrs (old: {
      passthru = (old.passthru or { }) // {
        updateScript = pkgs.dotfilesPackageUpdaters.flakeInputs [ "hjem" ];
      };
    });
    packages.hjem-files = import ../../home/deploy/nix/home.nix { inherit pkgs inputs; };
  };
}
