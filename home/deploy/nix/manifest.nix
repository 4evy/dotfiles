# Project public files through Hjem's native file options and serializer
# Targets are home-relative, with text/source and executable handled upstream
# Runtime records must bypass Nix evaluation to keep plaintext out of the store
{
  pkgs,
  inputs,
  home,
  files,
}:
let
  inherit (pkgs) lib stdenv;
  hjem = inputs.hjem.hjem-lib.${stdenv.hostPlatform.system};
  evaluated = lib.evalModules {
    modules = [
      {
        options.files = lib.mkOption {
          type = lib.types.attrsOf (
            hjem.fileTypeRelativeTo {
              rootDir = home;
              clobberDefault = true;
              clobberDefaultText = "true";
            }
          );
        };
        config.files = lib.listToAttrs (
          # Option names stay stable when other targets are added or removed
          map (file: {
            name = lib.strings.sanitizeDerivationName "hjem-${lib.hashString "sha256" file.target}-${baseNameOf file.target}";
            value = file;
          }) files
        );
      }
    ];
  };
  targets = map (file: file.target) files;
in
assert lib.assertMsg (
  lib.length targets == lib.length (lib.unique targets)
) "Duplicate public Hjem target";
{
  version = 3;
  files = map (
    file:
    hjem.fileToJson file
    # Copies are regenerated public settings, so replacing local edits is intentional
    // lib.optionalAttrs (file.type == "copy") { ignore_modification = true; }
  ) (lib.filter (file: file.enable) (lib.attrValues evaluated.config.files));
}
