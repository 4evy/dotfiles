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
        packages = lib.attrValues {
          inherit (unstable) bun nodejs;
          inherit (self'.packages) bun2nix;
        };
      };

      operationsShell = mkShell {
        packages =
          lib.attrValues {
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
          ++ lib.optionals isLinux (
            lib.attrValues {
              inherit (self'.packages) bluebuild-v2;
              inherit (pkgs) podman podman-compose;
            }
          );
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
          packages = lib.attrValues {
            inherit (config.treefmt.build) wrapper;
            inherit (pkgs) git just;
          };
          inherit (config.pre-commit) shellHook;
        };
      };
    };
}
