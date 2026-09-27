_lint-nix: (_run-files 'deadnix' ['*.nix', ':(exclude)hosts/linux/hardware-configuration.nix', ':(exclude)packages/hyper-window-tiling/bun.nix'] ['--fail'])
    for file in {{ quote(git_files(['*.nix'])) }}; do
      [[ -f $file && ! -L $file ]] || continue
      nix-instantiate --parse "$file" >/dev/null
    done
    statix check .

_lint-xml: (_run-files 'uv' ['*.plist', '*.xml'] ['run', 'python', '-c', 'import sys; from defusedxml.ElementTree import parse; [parse(path) for path in sys.argv[1:]]'])

# These substitution templates are build inputs, outside chezmoi's source state
_lint-input-templates:
    temporary_dir=$(mktemp -d)
    trap 'rm -rf "$temporary_dir"' EXIT
    for file in {{ quote(git_files(['*.py.in', '*.plist.in', '*.xml.in'])) }}; do
      [[ -f $file && ! -L $file ]] || continue
      rendered_file="$temporary_dir/${file%.in}"
      mkdir -p "${rendered_file%/*}"
      sed -E 's/@[A-Za-z_][A-Za-z0-9_]*@/template_value/g' "$file" > "$rendered_file"
      case "$file" in
        *.py.in) PYTHONPYCACHEPREFIX="$temporary_dir/pycache" uv run python -m py_compile "$rendered_file" ;;
        *) uv run python -c 'import sys; from defusedxml.ElementTree import parse; parse(sys.argv[1])' "$rendered_file" ;;
      esac
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
