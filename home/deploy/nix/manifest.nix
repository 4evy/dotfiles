# Project public files through Hjem's native file options and serializer
# Hjem resolves home/XDG roots and handles text/source and executable modes
# Runtime records must bypass Nix evaluation to keep plaintext out of the store
{
  pkgs,
  inputs,
  home,
  files,
  clobberDefault ? true,
}:
let
  inherit (pkgs) lib stdenv;
  hjem = inputs.hjem.hjem-lib.${stdenv.hostPlatform.system};
  evaluated = lib.modules.evalModules {
    modules = [
      {
        options.files = lib.options.mkOption {
          type = lib.types.attrsOf (
            hjem.fileTypeRelativeTo {
              rootDir = home;
              inherit clobberDefault;
              clobberDefaultText = builtins.toJSON clobberDefault;
            }
          );
        };
        # Option names stay stable when other targets are added or removed
        config.files = lib.attrsets.genAttrs' files (file: {
          name = lib.strings.sanitizeDerivationName "hjem-${builtins.hashString "sha256" file.target}-${baseNameOf file.target}";
          value = file;
        });
      }
    ];
  };
  targets = map (file: file.target) files;
in
# Discard context only for validation, not for the deployed file targets
assert lib.asserts.assertMsg (
  lib.lists.length targets
  == lib.lists.length (lib.lists.uniqueStrings (map builtins.unsafeDiscardStringContext targets))
) "Duplicate public Hjem target";
{
  version = 3;
  files = map hjem.fileToJson (
    lib.lists.filter (file: file.enable) (lib.attrsets.attrValues evaluated.config.files)
  );
}
