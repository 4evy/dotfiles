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

      rubyEnv = pkgs.bundlerEnv {
        name = "dotfiles-ruby";
        gemfile = ../../Gemfile;
        lockfile = ../../Gemfile.lock;
        gemset = {
          ast = {
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "10yknjyn0728gjn6b5syynvrvrwm66bhssbxq8mkhshxghaiailm";
              type = "gem";
            };
            version = "2.4.3";
          };
          json = {
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "0shwgjqbj856mb6m9kgkpy08nhym2gdvc2yaprlimfmky9y3n78z";
              type = "gem";
            };
            version = "2.21.2";
          };
          language_server-protocol = {
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "1w5p8c2145lmqzr25bxh4ikzjm6k8y1k5lriqqdpw9pq730w1wjy";
              type = "gem";
            };
            version = "3.17.0.6";
          };
          lint_roller = {
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "11yc0d84hsnlvx8cpk4cbj6a4dz9pk0r1k29p0n1fz9acddq831c";
              type = "gem";
            };
            version = "1.1.0";
          };
          parallel = {
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "0mlkn1vhh9lr7vljibpgspwsswk7mzm8nw6bbr616c9fbj35hlmk";
              type = "gem";
            };
            version = "2.1.0";
          };
          parser = {
            dependencies = [
              "ast"
              "racc"
            ];
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "0a4q5h2hcihk79dbr20scgkm56l79qp7fsvfvkxlv8nmapvxg9i1";
              type = "gem";
            };
            version = "3.3.12.0";
          };
          prism = {
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "11ggfikcs1lv17nhmhqyyp6z8nq5pkfcj6a904047hljkxm0qlvv";
              type = "gem";
            };
            version = "1.9.0";
          };
          racc = {
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "0byn0c9nkahsl93y9ln5bysq4j31q8xkf2ws42swighxd4lnjzsa";
              type = "gem";
            };
            version = "1.8.1";
          };
          rainbow = {
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "0smwg4mii0fm38pyb5fddbmrdpifwv22zv3d3px2xx497am93503";
              type = "gem";
            };
            version = "3.1.1";
          };
          regexp_parser = {
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "1fwfw26a32rps78920nn29shqg2zmqv72i89j1fap41isshida9m";
              type = "gem";
            };
            version = "2.12.0";
          };
          rubocop = {
            dependencies = [
              "json"
              "language_server-protocol"
              "lint_roller"
              "parallel"
              "parser"
              "rainbow"
              "regexp_parser"
              "rubocop-ast"
              "ruby-progressbar"
              "unicode-display_width"
            ];
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "1rxadw5awrddwh6zzkfsr0qq67h3zpbfingg6i44fpn4x4z8xvjd";
              type = "gem";
            };
            version = "1.89.0";
          };
          rubocop-ast = {
            dependencies = [
              "parser"
              "prism"
            ];
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "1nw84xk6vc2ls8sxqvyhxs2agh4l0jrws85d4bi3x0501lq8ijmr";
              type = "gem";
            };
            version = "1.50.0";
          };
          ruby-progressbar = {
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "0cwvyb7j47m7wihpfaq7rc47zwwx9k4v7iqd9s1xch5nm53rrz40";
              type = "gem";
            };
            version = "1.13.0";
          };
          unicode-display_width = {
            dependencies = [ "unicode-emoji" ];
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "0hiwhnqpq271xqari6mg996fgjps42sffm9cpk6ljn8sd2srdp8c";
              type = "gem";
            };
            version = "3.2.0";
          };
          unicode-emoji = {
            groups = [ "default" ];
            platforms = [ ];
            source = {
              remotes = [ "https://rubygems.org" ];
              sha256 = "03zqn207zypycbz5m9mn7ym763wgpk7hcqbkpx02wrbm1wank7ji";
              type = "gem";
            };
            version = "4.2.0";
          };
        };
      };

      rubocopFormatter = pkgs.writeShellApplication {
        name = "rubocop-format";
        runtimeEnv.GEM_PATH = "${rubyEnv}/${pkgs.ruby.gemPath}";
        text = ''
          exec ${rubyEnv}/bin/rubocop "$@"
        '';
      };

      templateFormatter = pkgs.writeShellApplication {
        name = "template-format";
        text = ''
          temporary_directory=$(mktemp -d)
          trap 'rm -rf "$temporary_directory"' EXIT

          for file in "$@"; do
            relative_file=''${file#./}
            output_name=$(basename "$file")
            xml=0

            case "$relative_file" in
              dotfiles/dot_bash*.tmpl | *.bash.tmpl | *.sh.tmpl)
                if ! ${lib.getExe pkgs.shfmt} -w "$file" >/dev/null 2>&1; then
                  printf 'Skipped unparseable template: %s\n' "$file" >&2
                fi
                continue
                ;;
              *.py.tmpl)
                output_name=''${output_name%.tmpl}
                formatter=(
                  ${lib.getExe pkgs.ruff}
                  format
                  --config ${../../pyproject.toml}
                )
                ;;
              *.rb.tmpl)
                output_name=''${output_name%.tmpl}
                formatter=(
                  ${lib.getExe rubocopFormatter}
                  --autocorrect-all
                  --config ${../../.rubocop.yml}
                )
                ;;
              *.toml.tmpl)
                output_name=''${output_name%.tmpl}
                formatter=(${lib.getExe pkgs.taplo} format)
                ;;
              *.yaml.tmpl | *.yml.tmpl)
                output_name=''${output_name%.tmpl}
                formatter=(
                  ${lib.getExe pkgs.yamlfmt}
                  -conf ${../../.yamlfmt}
                )
                ;;
              *.json.tmpl | *.jsonc.tmpl | *.css.in | *.css.tmpl | *.scss.tmpl)
                output_name=''${output_name%.tmpl}
                output_name=''${output_name%.in}
                formatter=(
                  ${lib.getExe pkgs.biome}
                  format
                  --write
                  --no-errors-on-unmatched
                )
                ;;
              *.plist.j2 | *.plist.tmpl | *.tmTheme.tmpl | *.xml.j2 | *.xml.tmpl)
                output_name=''${output_name%.j2}
                output_name=''${output_name%.tmpl}
                xml=1
                ;;
              dotfiles/dot_config/fontconfig/*.conf.tmpl)
                output_name=''${output_name%.tmpl}
                xml=1
                ;;
              *)
                continue
                ;;
            esac

            temporary_file="$temporary_directory/$output_name"
            cp "$file" "$temporary_file"
            formatted=0
            if ((xml)); then
              xml_output="$temporary_directory/formatted-$output_name"
              if ${lib.getExe' pkgs.libxml2 "xmllint"} \
                --format "$temporary_file" --output "$xml_output" \
                >/dev/null 2>&1; then
                mv "$xml_output" "$temporary_file"
                formatted=1
              fi
            elif "''${formatter[@]}" "$temporary_file" >/dev/null 2>&1; then
              formatted=1
            fi

            if ((formatted)); then
              if ! cmp -s "$file" "$temporary_file"; then
                cp "$temporary_file" "$file"
              fi
            else
              printf 'Skipped unparseable template: %s\n' "$file" >&2
            fi
          done
        '';
      };

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

      operationsShell = pkgs.mkShell {
        inputsFrom = [ pythonShell ];
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
        inherit (self'.packages) dotfiles-python equicord-settings theme-run;
      }
      // lib.optionalAttrs isLinux {
        hyper-window-tiling = self'.packages.hyper-window-tiling-gnome;
        toshy-runtime = self'.packages.toshy-runtime;
      }
      // lib.optionalAttrs (system == "x86_64-linux") {
        nixos = self.nixosConfigurations.nixos.config.system.build.toplevel;
      };

      devShells = {
        python = pythonShell;
        javascript = javascriptShell;
        operations = operationsShell;
        default = pkgs.mkShell {
          inputsFrom = [
            config.pre-commit.devShell
            pythonShell
            javascriptShell
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
        statix.enable = true;
        hadolint = {
          enable = true;
          files = "(Dockerfile|Containerfile)$";
        };
        luacheck.enable = true;
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
        enableDefaultExcludes = false;
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
          gofmt = {
            enable = true;
            package = pkgs.go_1_27;
          };
          just.enable = true;
          nixfmt.enable = true;
          ruff-format.enable = true;
          rumdl-format.enable = true;
          shfmt = {
            enable = true;
            useEditorConfig = true;
          };
          stylua.enable = true;
          taplo.enable = true;
          xmllint.enable = true;
          yamlfmt.enable = true;
        };

        settings = {
          excludes = [
            "*.lock"
            "*.patch"
            "package-lock.json"
            "go.sum"
            "go.work.sum"
            ".gitattributes"
            ".gitignore"
            ".gitmodules"
            ".hgignore"
            ".svnignore"
            "LICENSE"
          ];

          formatter = {
            go-mod = {
              command = pkgs.writeShellApplication {
                name = "go-mod-format";
                text = ''
                  temporary_directory=$(mktemp -d)
                  trap 'rm -rf "$temporary_directory"' EXIT
                  for file in "$@"; do
                    # Go rewrites even unchanged files; treefmt uses mtimes to
                    # detect changes. -print leaves the source untouched.
                    case "$file" in
                      *go.work) kind=work ;;
                      *) kind=mod ;;
                    esac
                    ${lib.getExe pkgs.go_1_27} "$kind" edit -fmt -print "$file" > "$temporary_directory/formatted"
                    if ! cmp -s "$file" "$temporary_directory/formatted"; then
                      cp "$temporary_directory/formatted" "$file"
                    fi
                  done
                '';
              };
              includes = [
                "go.mod"
                "*/go.mod"
                "go.work"
              ];
            };

            rubocop = {
              command = rubocopFormatter;
              excludes = [ "Formula/*.rb" ];
              includes = [
                "*.rb"
                "Brewfile"
                "Gemfile"
              ];
              options = [
                "--autocorrect-all"
                "--force-exclusion"
              ];
            };

            shfmt = {
              includes = lib.mkAfter [
                "dotfiles/dot_local/bin/executable_*"
                "bluebuild/files/system/usr/bin/*"
              ];
              excludes = [
                "*.py"
                "dotfiles/dot_local/bin/executable_ghostty-dreamy-swirl.ts"
                "dotfiles/dot_local/bin/executable_sops-age-key-cache.rb"
              ];
            };

            stylua.includes = lib.mkAfter [ ".luacheckrc" ];
            yamlfmt.includes = lib.mkAfter [ ".yamlfmt" ];

            swift-format = {
              command = lib.getExe pkgs.swift-format;
              includes = [ "*.swift" ];
              options = [ "--in-place" ];
            };

            template = {
              command = templateFormatter;
              includes = [
                "*.in"
                "*.j2"
                "*.tmpl"
              ];
            };

            xmllint.includes = lib.mkAfter [
              "*.plist"
              "*.plist.in"
              "dotfiles/dot_config/fontconfig/conf.d/45-interface-fonts.conf"
              "dotfiles/dot_config/fontconfig/conf.d/50-code-monospace.conf"
            ];

            zig = {
              command = lib.getExe pkgs.zig;
              includes = [ "*.zig" ];
              options = [ "fmt" ];
            };
          };
        };
      };
    };
}
