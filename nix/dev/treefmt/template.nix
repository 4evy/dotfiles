{
  lib,
  pkgs,
}:
let
  inherit (pkgs)
    biome
    formats
    libxml2
    ruff
    shfmt
    taplo
    writeShellApplication
    yamlfmt
    ;
  ruffConfig =
    (formats.toml { }).generate "ruff.toml"
      (lib.importTOML ../../../pyproject.toml).tool.ruff;
in
writeShellApplication {
  name = "template-format";
  runtimeInputs = lib.attrValues {
    inherit (pkgs) coreutils diffutils;
  };
  text = ''
    temporary_directory=$(mktemp -d)
    trap 'rm -rf "$temporary_directory"' EXIT

    for file in "$@"; do
      relative_file=''${file#./}
      output_name=$(basename "$file")
      xml=0

      case "$relative_file" in
        *.bash.in | *.sh.in)
          if ! ${lib.getExe shfmt} -w "$file" >/dev/null 2>&1; then
            printf 'Skipped unparseable template: %s\n' "$file" >&2
          fi
          continue
          ;;
        *.py.in)
          output_name=''${output_name%.in}
          formatter=(
            ${lib.getExe ruff}
            format
            --config ${ruffConfig}
          )
          ;;
        *.toml.in)
          output_name=''${output_name%.in}
          formatter=(${lib.getExe taplo} format)
          ;;
        *.yaml.in | *.yml.in)
          output_name=''${output_name%.in}
          formatter=(
            ${lib.getExe yamlfmt}
            -conf ${../../../.yamlfmt}
          )
          ;;
        *.json.in | *.jsonc.in | *.css.in | *.scss.in)
          output_name=''${output_name%.in}
          output_name=''${output_name%.in}
          formatter=(
            ${lib.getExe biome}
            format
            --write
            --no-errors-on-unmatched
          )
          ;;
        *.plist.j2 | *.plist.in | *.tmTheme.in | *.xml.j2 | *.xml.in)
          output_name=''${output_name%.j2}
          output_name=''${output_name%.in}
          xml=1
          ;;
        dotfiles/home/.config/fontconfig/*.conf.in)
          output_name=''${output_name%.in}
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
        if ${lib.getExe' libxml2 "xmllint"} \
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
}
