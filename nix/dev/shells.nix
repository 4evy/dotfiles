{ lib, ... }:
{
  _class = "flake";

  perSystem =
    {
      config,
      pkgs,
      self',
      ...
    }:
    let
      inherit (pkgs) mkShell stdenv unstable;
      inherit (stdenv.hostPlatform) isLinux;

      javascriptShell = mkShell {
        packages = lib.attrsets.attrValues {
          inherit (unstable) bun nodejs;
          inherit (self'.packages) bun2nix;
        };
      };

      operationsShell = mkShell {
        packages =
          lib.attrsets.attrValues {
            inherit (pkgs)
              actionlint
              check-jsonschema
              cosign
              hadolint
              jq
              shellcheck
              skopeo
              syft
              yamllint
              yq-go
              zizmor
              ;
            inherit (unstable) uv;
          }
          # Use the host container engine with its matching storage and helpers
          ++ lib.lists.optionals isLinux [ self'.packages.bluebuild-v2 ];
      };

    in
    {
      devShells = {
        javascript = javascriptShell;
        operations = operationsShell;
        default = mkShell {
          inputsFrom = [
            config.pre-commit.devShell
            javascriptShell
            operationsShell
          ];
          packages = lib.attrsets.attrValues {
            inherit (config.treefmt.build) wrapper;
            inherit (pkgs) git just;
          };
          inherit (config.pre-commit) shellHook;
        };
      };
    };
}
