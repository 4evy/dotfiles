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
      inherit (unstable) python314;
      # inputsFrom inherits dependencies and hooks, not environment variables
      pythonEnvironment = {
        UV_PYTHON = python314.interpreter;
        UV_PYTHON_DOWNLOADS = "never";
      };
      pythonShell = mkShell {
        packages = lib.attrValues {
          inherit (unstable) python314 uv;
        };
        env = pythonEnvironment;
      };

      javascriptShell = mkShell {
        packages = lib.attrValues {
          inherit (unstable) bun nodejs;
          inherit (self'.packages) bun2nix;
        };
      };

      operationsShell = mkShell {
        inputsFrom = [ pythonShell ];
        env = pythonEnvironment;
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
        python = pythonShell;
        javascript = javascriptShell;
        operations = operationsShell;
        default = mkShell {
          inputsFrom = [
            config.pre-commit.devShell
            pythonShell
            javascriptShell
            operationsShell
          ];
          env = pythonEnvironment;
          packages = lib.attrValues {
            inherit (config.treefmt.build) wrapper;
            inherit (pkgs) git just;
          };
          inherit (config.pre-commit) shellHook;
        };
      };
    };
}
