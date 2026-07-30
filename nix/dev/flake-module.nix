{
  inputs,
  lib,
  self,
  ...
}:
{
  imports = [
    inputs.git-hooks-nix.flakeModule
    inputs.treefmt-nix.flakeModule
  ];

  perSystem =
    {
      config,
      pkgs,
      self',
      system,
      ...
    }:
    let
      inherit (pkgs.stdenv.hostPlatform) isLinux;

      pythonShell = pkgs.mkShell {
        packages =
          with pkgs;
          [
            unstable.python314
            unstable.uv
          ]
          ++ [ self'.packages.dotfiles-python ];
        env = {
          UV_PYTHON = pkgs.unstable.python314.interpreter;
          UV_PYTHON_DOWNLOADS = "never";
        };
      };

      javascriptShell = pkgs.mkShell {
        packages =
          with pkgs;
          [
            unstable.bun
            unstable.nodejs
          ]
          ++ [ self'.packages.bun2nix ];
      };

      cShell = pkgs.mkShell {
        packages =
          with pkgs;
          lib.optionals isLinux [
            clang-tools
            glib
            libvterm-neovim
            meson
            ninja
            pkg-config
          ];
        inputsFrom = lib.optionals isLinux [ self'.packages.terminal-theme-tools ];
      };

      operationsShell = pkgs.mkShell {
        packages =
          with pkgs;
          [
            actionlint
            ansible
            ansible-lint
            check-jsonschema
            cosign
            hadolint
            jq
            npins
            shellcheck
            skopeo
            syft
            yamllint
            yq-go
            zizmor
          ]
          ++ lib.optionals isLinux [ self'.packages.bluebuild-v2 ]
          ++ (
            with pkgs;
            lib.optionals isLinux [
              podman
              podman-compose
            ]
          );
      };
    in
    {
      checks = {
        inherit (self'.packages) dotfiles-python equicord-settings;
      }
      // lib.optionalAttrs isLinux {
        inherit (self'.packages) terminal-theme-tools;
        hyper-window-tiling = self'.packages.hyper-window-tiling-gnome.tests.workspace;
      }
      // lib.optionalAttrs (system == "x86_64-linux") {
        nixos = self.nixosConfigurations.nixos.config.system.build.toplevel;
      };

      devShells = {
        python = pythonShell;
        javascript = javascriptShell;
        c = cShell;
        operations = operationsShell;
        default = pkgs.mkShell {
          inputsFrom = [
            config.pre-commit.devShell
            pythonShell
            javascriptShell
            cShell
            operationsShell
          ];
          packages = [
            config.treefmt.build.wrapper
          ]
          ++ (with pkgs; [
            git
            just
          ]);
          inherit (config.pre-commit) shellHook;
        };
      };

      pre-commit.settings.hooks = {
        actionlint.enable = true;
        ansible-lint = {
          enable = true;
          args = [
            "--offline"
            "ansible"
          ];
          settings.subdir = "ansible";
        };
        biome.enable = true;
        deadnix = {
          enable = true;
          excludes = [
            "hosts/linux/hardware-configuration.nix"
            "packages/hyper-window-tiling/bun.nix"
          ];
        };
        hadolint = {
          enable = true;
          files = "(Dockerfile|Containerfile)$";
        };
        luacheck = {
          enable = true;
          args = [
            "--globals"
            "Command"
            "cx"
            "ya"
            "--"
          ];
        };
        lua-tests = {
          enable = true;
          entry = "${lib.getExe pkgs.lua} dotfiles/dot_config/yazi/plugins/system-clipboard.yazi/test.lua dotfiles/dot_config/yazi/plugins/system-clipboard.yazi/main.lua";
          files = "^dotfiles/dot_config/yazi/plugins/system-clipboard\\.yazi/(main|test)\\.lua$";
          name = "Lua tests";
          pass_filenames = false;
        };
        ruff.enable = true;
        rumdl.enable = true;
        shellcheck.enable = true;
        treefmt.enable = true;
        yamllint.enable = true;
        zizmor = {
          enable = true;
          args = [
            "--offline"
            "--persona=pedantic"
          ];
        };
      };

      treefmt = {
        projectRootFile = "flake.nix";

        programs = {
          biome = {
            enable = true;
            formatCommand = "format";
            settings = lib.recursiveUpdate (builtins.fromJSON (builtins.readFile ../../biome.jsonc)) {
              # treefmt already walks the Git worktree and passes the selected
              # files explicitly. The generated config lives in the Nix store,
              # where Biome cannot discover this checkout's ignore file.
              vcs.enabled = false;
            };
            validate.enable = false;
          };
          clang-format.enable = true;
          just.enable = true;
          nixfmt.enable = true;
          ruff-format.enable = true;
          rumdl-format.enable = true;
          shfmt = {
            enable = true;
            indent_size = 0;
            simplify = false;
          };
          stylua.enable = true;
          taplo.enable = true;
        };

        settings.formatter = {
          shfmt = {
            includes = lib.mkAfter [
              "dotfiles/dot_local/bin/executable_*"
              "files/system/usr/bin/*"
            ];
            excludes = [
              "dotfiles/dot_local/bin/executable_ghostty-dreamy-swirl.ts"
              "dotfiles/dot_local/bin/executable_helix-rumdl-lsp"
              "files/system/usr/bin/open"
            ];
            options = lib.mkAfter [ "-ci" ];
          };
        };
      };
    };
}
