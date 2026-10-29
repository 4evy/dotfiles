{ inputs, lib, ... }:
{
  _class = "flake";

  imports = [ inputs.treefmt-nix.flakeModule ];
  perSystem =
    { pkgs, ... }:
    let
      inherit (pkgs)
        unstable
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
          just.enable = true;
          nixfmt.enable = true;
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
          swift-format.enable = true;
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
          ];

          formatter = {

            shfmt = {
              includes = lib.mkAfter [
                "home/files/.local/bin/*"
                "systems/spectrum/files/system/usr/bin/*"
              ];
              excludes = [
                "*.py"
                "*.ts"
              ];
            };

            stylua.includes = lib.mkAfter [ ".luacheckrc" ];
            yamlfmt.includes = lib.mkAfter [ ".yamlfmt" ];

            template = {
              command = templateFormatter;
              includes = [
                "tools/workstation/assets/desktop/gtk/gtk.css.in"
                "tools/workstation/assets/desktop/gtk/legacy.css.in"
              ];
            };

            xmllint.includes = lib.mkAfter [
              "*.plist"
              "*.plist.in"
              "home/files/.config/fontconfig/conf.d/45-interface-fonts.conf"
              "home/files/.config/fontconfig/conf.d/50-code-monospace.conf"
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
