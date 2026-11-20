{
  inputs,
  lib,
  withSystem,
  ...
}:
{
  _class = "flake";

  flake.lib = {
    /**
      Build public Hjem files and hooks for the host described by `runtimeJSON`

      # Type
      `hjemHome :: String -> Derivation`

      # Examples
      `(hjemHome ''{"system":"aarch64-darwin","environment":{}}'').name`
      returns `"hjem-home"`
    */
    hjemHome =
      runtimeJSON:
      let
        runtime = lib.strings.fromJSON runtimeJSON;
      in
      withSystem runtime.system (
        { pkgs, ... }:
        import ../../home/deploy/nix/home.nix {
          inherit pkgs inputs;
          inherit (runtime) environment;
        }
      );

    /**
      Build the standalone Linux Hjem configuration from public host settings

      # Type
      `hjemConfiguration :: String -> Derivation`

      # Examples
      `(hjemConfiguration ''{"environment":{"HOME":"/home/user"}}'').name`
      returns `"hjem-configuration.nix"`
    */
    hjemConfiguration =
      runtimeJSON:
      withSystem "x86_64-linux" (
        { pkgs, self', ... }:
        let
          inherit (pkgs) callPackage dotfilesPackageUpdaters writeText;
          runtime = lib.strings.fromJSON runtimeJSON;
          configuration = import ../../home/deploy/nix {
            inherit pkgs inputs;
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
