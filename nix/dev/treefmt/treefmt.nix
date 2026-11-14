{ inputs, lib, ... }:
{
  _class = "flake";

  imports = [ inputs.treefmt-nix.flakeModule ];
  perSystem =
    { config, pkgs, ... }:
    let
      templateFormatter = import ./template.nix {
        inherit lib pkgs;
      };

    in
    {
      treefmt = {
        enableDefaultExcludes = false;
        projectRootFile = "flake.nix";
        build.wrapper = pkgs.writeShellApplication {
          name = "treefmt";
          runtimeInputs = [
            pkgs.flock
            pkgs.git
            pkgs.just
          ];
          text = ''
            unset PRJ_ROOT
            ${lib.meta.getExe pkgs.treefmt} \
              --config-file=${config.treefmt.build.configFile} \
              --tree-root-file=flake.nix "$@"

            format_records=0
            (($#)) || format_records=1
            for argument in "$@"; do
              case "$argument" in
                --help|-h|--version|--completion) exit 0 ;;
                .) format_records=1 ;;
              esac
            done
            if ((format_records)); then
              ${builtins.readFile ./records.sh}
            fi
          '';
        };

        programs = {
          biome = {
            enable = true;
            formatCommand = "format";
            settings = {
              # Let Biome parse JSONC rather than Nix's strict JSON parser
              extends = [ "${../../../biome.jsonc}" ];
              # treefmt passes files explicitly, without worktree discovery
              vcs.enabled = false;
            };
            validate.enable = false;
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
            ".gitattributes"
            ".gitignore"
            ".gitmodules"
            ".hgignore"
            ".svnignore"
            "LICENSE"
            # Records are formatted after decryption by the treefmt wrapper
            "secrets/**"
            # Match the existing Biome and EditorConfig vendor exclusions
            "tools/tiling/vendor/**"
          ];

          formatter = {
            whitespace = {
              command = pkgs.writeShellApplication {
                name = "whitespace-format";
                text = ''
                  exec ${lib.meta.getExe pkgs.python3} ${./whitespace.py} "$@"
                '';
              };
              includes = [ "*" ];
              # Run after syntax formatters and preserve Markdown hard breaks
              priority = 1;
            };
            biome-extensions = {
              command = pkgs.writeShellApplication {
                name = "biome-extensions-format";
                text = ''
                  temporary_file=$(mktemp)
                  trap 'rm -f "$temporary_file"' EXIT
                  for file in "$@"; do
                    case "$file" in
                      *.gjs) parser_path="$file.js" ;;
                      *) parser_path="$file.jsonc" ;;
                    esac
                    ${lib.meta.getExe pkgs.biome} format --vcs-enabled=false \
                      --stdin-file-path "$parser_path" < "$file" > "$temporary_file"
                    if ! cmp -s "$file" "$temporary_file"; then
                      cat "$temporary_file" > "$file"
                    fi
                  done
                '';
              };
              includes = [
                "*.gjs"
                "*.jsonc.darwin"
                "*.jsonc.linux"
              ];
            };
            ruby = {
              command = lib.meta.getExe pkgs.rubyfmt;
              options = [ "--in-place" ];
              includes = [
                "Brewfile"
                "Brewfile.*"
                "*.rb"
              ];
            };
            shfmt = {
              includes = lib.modules.mkAfter [
                "home/files/.bash*"
                "home/files/.local/share/bash-completion/homebrew/completions"
                "systems/spectrum/files/system/usr/bin/*"
                "systems/spectrum/files/system/usr/libexec/dotfiles/*"
              ];
              excludes = [
                "*.py"
                "*.ts"
              ];
            };

            stylua.includes = lib.modules.mkAfter [ ".luacheckrc" ];
            taplo.includes = lib.modules.mkAfter [ "*.toml.*" ];
            yamlfmt.includes = lib.modules.mkAfter [
              ".clang-format"
              ".yamlfmt"
              ".yamllint"
            ];

            template = {
              command = templateFormatter;
              includes = [
                "*.scss"
                "tools/workstation/assets/desktop/gtk/gtk.css.in"
                "tools/workstation/assets/desktop/gtk/legacy.css.in"
              ];
            };

            xmllint.includes = lib.modules.mkAfter [
              "*.plist"
              "*.plist.in"
              "*.tmTheme"
              "home/files/.config/fontconfig/conf.d/*.conf.*"
              "home/files/.config/fontconfig/conf.d/45-interface-fonts.conf"
              "home/files/.config/fontconfig/conf.d/50-code-monospace.conf"
            ];
          };
        };
      };
    };
}
