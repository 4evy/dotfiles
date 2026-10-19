{ inputs, lib, ... }:
{
  _class = "flake";

  imports = [ inputs.treefmt-nix.flakeModule ];
  perSystem =
    { pkgs, ... }:
    let
      inherit (pkgs)
        go_1_27
        swift-format
        unstable
        writeShellApplication
        zig
        ;
      templateFormatter = import ./template.nix {
        inherit lib pkgs;
      };

    in
    {
      treefmt = {
        enableDefaultExcludes = false;
        projectRootFile = "flake.nix";

        programs = {
          biome = {
            enable = true;
            formatCommand = "format";
            settings = lib.recursiveUpdate (lib.importJSON ../../../biome.jsonc) {
              # treefmt already walks the Git worktree and passes the selected
              # files explicitly; the generated config lives in the Nix store,
              # where Biome cannot discover this checkout's ignore file
              vcs.enabled = false;
            };
            validate.enable = false;
          };
          clang-format.enable = true;
          gofmt = {
            enable = true;
            package = go_1_27;
          };
          just.enable = true;
          nixfmt.enable = true;
          ruff-format.enable = true;
          rumdl-format.enable = true;
          rustfmt = {
            enable = true;
            package = unstable.rustfmt;
            edition = "2024";
          };
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
              command = writeShellApplication {
                name = "go-mod-format";
                runtimeInputs = lib.attrValues {
                  inherit (pkgs) coreutils diffutils;
                };
                text = ''
                  temporary_directory=$(mktemp -d)
                  trap 'rm -rf "$temporary_directory"' EXIT
                  for file in "$@"; do
                    # Go rewrites even unchanged files; treefmt uses mtimes to
                    # detect changes; -print leaves the source untouched
                    case "$file" in
                      *go.work) kind=work ;;
                      *) kind=mod ;;
                    esac
                    ${lib.getExe go_1_27} "$kind" edit -fmt -print "$file" > "$temporary_directory/formatted"
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

            shfmt = {
              includes = lib.mkAfter [
                "dotfiles/home/.local/bin/*"
                "bluebuild/files/system/usr/bin/*"
              ];
              excludes = [
                "*.py"
                "*.ts"
              ];
            };

            stylua.includes = lib.mkAfter [ ".luacheckrc" ];
            yamlfmt.includes = lib.mkAfter [ ".yamlfmt" ];

            swift-format = {
              command = lib.getExe swift-format;
              includes = [ "*.swift" ];
              options = [ "--in-place" ];
            };

            template = {
              command = templateFormatter;
              includes = [
                "*.in"
                "*.j2"
              ];
            };

            xmllint.includes = lib.mkAfter [
              "*.plist"
              "*.plist.in"
              "dotfiles/home/.config/fontconfig/conf.d/45-interface-fonts.conf"
              "dotfiles/home/.config/fontconfig/conf.d/50-code-monospace.conf"
            ];

            zig = {
              command = lib.getExe zig;
              includes = [ "*.zig" ];
              options = [ "fmt" ];
            };
          };
        };
      };
    };
}
