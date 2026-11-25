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
          inherit (pkgs) bun;
          # Match CI's Node ABI when running Renovate's native RE2 addon
          inherit (unstable) nodejs_26;
          inherit (self'.packages) bun2nix;
        };
      };

      operationsShell = mkShell {
        packages =
          lib.attrsets.attrValues {
            inherit (pkgs)
              actionlint
              bun
              cosign
              hadolint
              jq
              shellcheck
              skopeo
              syft
              yamllint
              yq-go
              ;
            inherit (unstable) uv zizmor;
          }
          # Use the host container engine with its matching storage and helpers
          ++ lib.lists.optionals isLinux [ unstable.bluebuild ];
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
        };
      };
    };
}
