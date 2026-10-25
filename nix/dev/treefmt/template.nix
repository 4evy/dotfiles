{ lib, pkgs }:
pkgs.writeShellApplication {
  name = "template-format";
  runtimeInputs = lib.attrValues {
    inherit (pkgs) coreutils diffutils;
  };
  text = ''
    temporary_directory=$(mktemp -d)
    trap 'rm -rf "$temporary_directory"' EXIT

    for file in "$@"; do
      case "$file" in
        *.css.in) ;;
        *) continue ;;
      esac
      output_name=$(basename "$file" .in)
      temporary_file="$temporary_directory/$output_name"
      cp "$file" "$temporary_file"
      if ${lib.getExe pkgs.biome} format --write --no-errors-on-unmatched \
        "$temporary_file" >/dev/null 2>&1; then
        if ! cmp -s "$file" "$temporary_file"; then
          cp "$temporary_file" "$file"
        fi
      else
        printf 'Skipped unparseable template: %s\n' "$file" >&2
      fi
    done
  '';
}
