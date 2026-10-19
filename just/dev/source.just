_lint-nix: (_run-files 'deadnix' ['*.nix', ':(exclude)hosts/linux/hardware-configuration.nix'] ['--fail'])
    for file in {{ quote(git_files(['*.nix'])) }}; do
      [[ -f $file && ! -L $file ]] || continue
      nix-instantiate --parse "$file" >/dev/null
    done
    statix check .

_lint-xml: (_run-files 'bun' ['*.plist', '*.xml'] ['scripts/check/xml.ts'])

# These substitution templates are build inputs, outside the managed home tree
_lint-input-templates:
    temporary_dir=$(mktemp -d)
    trap 'rm -rf "$temporary_dir"' EXIT
    for file in {{ quote(git_files(['*.plist.in', '*.xml.in'])) }}; do
      [[ -f $file && ! -L $file ]] || continue
      rendered_file="$temporary_dir/${file%.in}"
      mkdir -p "${rendered_file%/*}"
      sed -E 's/@[A-Za-z_][A-Za-z0-9_]*@/template_value/g' "$file" > "$rendered_file"
      bun scripts/check/xml.ts "$rendered_file"
    done

_lint-shell-files:
    shell_files=()
    for file in {{ quote(git_files([])) }}; do
      [[ -f $file && ! -L $file ]] || continue
      case "$file" in
        *.tmpl | *.txt | *.patch) continue ;;
        *.sh | *.sh.in | *.bash) shell_files+=("$file"); continue ;;
      esac
      if head -n 2 < "$file" | grep -Eq '^#!.*[[:space:]/](sh|bash)([[:space:]]|$)|^# shellcheck shell=(sh|bash)'; then
        shell_files+=("$file")
      fi
    done
    ((${#shell_files[@]} == 0)) && exit
    shellcheck -x "${shell_files[@]}"
