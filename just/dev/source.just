_lint-nix: (_run-files 'deadnix' ['*.nix', ':(exclude)hosts/linux/hardware-configuration.nix', ':(exclude)packages/hyper-window-tiling/bun.nix'] ['--fail'])
    for file in {{ quote(git_files(['*.nix'])) }}; do
      [[ -f $file && ! -L $file ]] || continue
      nix-instantiate --parse "$file" >/dev/null
    done
    statix check .

_lint-xml: (_run-files 'uv' ['*.plist', '*.xml'] ['run', 'python', '-c', 'import sys; from defusedxml.ElementTree import parse; [parse(path) for path in sys.argv[1:]]'])

_lint-templates:
    python_template_files=()
    ruby_template_files=()
    json_template_files=()
    toml_template_files=()
    xml_template_files=()
    bash_template_files=()
    zsh_template_files=()
    python_input_template_files=()
    xml_input_template_files=()
    for file in {{ quote(git_files(['*.tmpl', '*.py.in', '*.plist.in', '*.xml.in'])) }}; do
      [[ -f $file && ! -L $file ]] || continue
      case "$file" in
        dotfiles/.chezmoitemplates/*) ;;
        dotfiles/dot_bash*.tmpl | *.bash.tmpl | *.sh.tmpl) bash_template_files+=("$file") ;;
        dotfiles/dot_zsh*.tmpl | *.zsh.tmpl) zsh_template_files+=("$file") ;;
        *.py.tmpl) python_template_files+=("$file") ;;
        *.rb.tmpl) ruby_template_files+=("$file") ;;
        *.json.tmpl) json_template_files+=("$file") ;;
        *.toml.tmpl) toml_template_files+=("$file") ;;
        *.plist.tmpl | *.xml.tmpl | *.tmTheme.tmpl) xml_template_files+=("$file") ;;
        *.py.in) python_input_template_files+=("$file") ;;
        *.plist.in | *.xml.in) xml_input_template_files+=("$file") ;;
      esac
    done

    tmp_destination=$(mktemp -d)
    trap 'rm -rf "$tmp_destination"' EXIT
    chezmoi \
      --persistent-state "$tmp_destination/chezmoi.boltdb" \
      apply \
      --dry-run \
      --source {{ quote(repo_dir) }} \
      --destination "$tmp_destination" \
      --exclude encrypted \
      --force \
      --no-tty \
      --refresh-externals=never >/dev/null

    for file in \
      "${bash_template_files[@]}" \
      "${zsh_template_files[@]}"; do
      rendered_file="$tmp_destination/rendered-templates/${file%.tmpl}"
      mkdir -p "${rendered_file%/*}"
      chezmoi \
        --persistent-state "$tmp_destination/chezmoi.boltdb" \
        --source {{ quote(repo_dir) }} \
        execute-template < "$file" > "$rendered_file"
    done
    script_platform_overrides=(
      '{"chezmoi":{"os":"darwin","arch":"arm64","osRelease":{}}}'
      '{"chezmoi":{"os":"linux","arch":"amd64","osRelease":{"id":"fedora"}}}'
    )
    rendered_python_files=()
    rendered_ruby_files=()
    rendered_json_files=()
    rendered_toml_files=()
    rendered_xml_template_files=()
    platform_index=0
    for platform_override in "${script_platform_overrides[@]}"; do
      platform_index=$((platform_index + 1))
      for file in \
        "${python_template_files[@]}" \
        "${ruby_template_files[@]}" \
        "${json_template_files[@]}" \
        "${toml_template_files[@]}" \
        "${xml_template_files[@]}"; do
        rendered_file="$tmp_destination/rendered-script-templates/$platform_index/${file%.tmpl}"
        mkdir -p "${rendered_file%/*}"
        chezmoi \
          --persistent-state "$tmp_destination/chezmoi.boltdb" \
          --source {{ quote(repo_dir) }} \
          --override-data "$platform_override" \
          execute-template < "$file" > "$rendered_file"
        [[ -s $rendered_file ]] || continue
        case "$file" in
          *.py.tmpl) rendered_python_files+=("$rendered_file|${file%.tmpl}") ;;
          *.rb.tmpl) rendered_ruby_files+=("$rendered_file") ;;
          *.json.tmpl) rendered_json_files+=("$rendered_file") ;;
          *.toml.tmpl) rendered_toml_files+=("$rendered_file") ;;
          *.plist.tmpl | *.xml.tmpl | *.tmTheme.tmpl)
            rendered_xml_template_files+=("$rendered_file")
            ;;
        esac
      done
    done
    if ((${#rendered_python_files[@]} > 0)); then
      PYTHONPYCACHEPREFIX="$tmp_destination/pycache" \
        uv run python -m compileall -q "$tmp_destination/rendered-script-templates"
      for rendered_python in "${rendered_python_files[@]}"; do
        rendered_file=${rendered_python%%|*}
        source_file=${rendered_python#*|}
        uv run ruff check --stdin-filename "$source_file" - < "$rendered_file"
      done
    fi
    for rendered_file in "${rendered_ruby_files[@]}"; do
      ruby -c "$rendered_file" >/dev/null
    done
    for rendered_file in "${rendered_json_files[@]}"; do
      jq empty "$rendered_file"
    done
    for rendered_file in "${rendered_toml_files[@]}"; do
      if ! taplo_output=$(taplo lint "$rendered_file" 2>&1); then
        printf 'invalid rendered TOML: %s\n%s\n' "$rendered_file" "$taplo_output" >&2
        exit 1
      fi
    done
    ((${#rendered_xml_template_files[@]} == 0)) || uv run python -c \
      'import sys; from defusedxml.ElementTree import parse; [parse(path) for path in sys.argv[1:]]' \
      "${rendered_xml_template_files[@]}"
    for file in "${bash_template_files[@]}"; do
      rendered_file="$tmp_destination/rendered-templates/${file%.tmpl}"
      bash -n "$rendered_file"
      # Cached integrations are generated by their upstream tools. Syntax-check
      # them, but reserve ShellCheck policy for shell code maintained here.
      case "$file" in
        dotfiles/dot_cache/* | dotfiles/dot_local/share/bash-completion/completions/*) continue ;;
      esac
      shellcheck -x --shell=bash "$rendered_file"
    done
    for file in "${zsh_template_files[@]}"; do
      zsh -n "$tmp_destination/rendered-templates/${file%.tmpl}"
    done
    for file in "${python_input_template_files[@]}"; do
      rendered_file="$tmp_destination/rendered-input-templates/${file%.in}"
      mkdir -p "${rendered_file%/*}"
      sed -E 's/@[A-Za-z_][A-Za-z0-9_]*@/template_value/g' "$file" > "$rendered_file"
    done
    if ((${#python_input_template_files[@]} > 0)); then
      PYTHONPYCACHEPREFIX="$tmp_destination/pycache" \
        uv run python -m compileall -q "$tmp_destination/rendered-input-templates"
    fi
    rendered_xml_files=()
    for file in "${xml_input_template_files[@]}"; do
      rendered_file="$tmp_destination/rendered-input-templates/${file%.in}"
      mkdir -p "${rendered_file%/*}"
      sed -E 's/@[A-Za-z_][A-Za-z0-9_]*@/template_value/g' "$file" > "$rendered_file"
      rendered_xml_files+=("$rendered_file")
    done
    ((${#rendered_xml_files[@]} == 0)) || uv run python -c \
      'import sys; from defusedxml.ElementTree import parse; [parse(path) for path in sys.argv[1:]]' \
      "${rendered_xml_files[@]}"

_lint-shell-templates-portable:
    platform_overrides=(
      '{"chezmoi":{"os":"darwin","arch":"arm64","osRelease":{}}}'
      '{"chezmoi":{"os":"linux","arch":"amd64","osRelease":{"id":"fedora"}}}'
      '{"chezmoi":{"os":"linux","arch":"amd64","osRelease":{"id":"nixos"}}}'
    )
    shell_template_files=()
    for file in {{ quote(git_files(['dotfiles/dot_bash*.tmpl', 'dotfiles/dot_zsh*.tmpl', 'dotfiles/dot_config/shell/*.tmpl', 'dotfiles/dot_config/shell/exact_bashrc.d/*.tmpl', 'dotfiles/dot_config/shell/exact_interactive.d/*.tmpl', 'dotfiles/dot_config/shell/exact_zshrc.d/*.tmpl'])) }}; do
      [[ -f $file && ! -L $file ]] && shell_template_files+=("$file")
    done

    tmp_destination=$(mktemp -d)
    trap 'rm -rf "$tmp_destination"' EXIT
    platform_index=0
    for platform_override in "${platform_overrides[@]}"; do
      platform_index=$((platform_index + 1))
      for file in "${shell_template_files[@]}"; do
        rendered_file="$tmp_destination/$platform_index/${file%.tmpl}"
        mkdir -p "${rendered_file%/*}"
        chezmoi \
          --persistent-state "$tmp_destination/chezmoi.boltdb" \
          --source {{ quote(repo_dir) }} \
          --override-data "$platform_override" \
          execute-template < "$file" > "$rendered_file"
        case "$file" in
          dotfiles/dot_bash*.tmpl | *.bash.tmpl)
            bash -n "$rendered_file"
            shellcheck -x --shell=bash "$rendered_file"
            ;;
          dotfiles/dot_zsh*.tmpl | *.zsh.tmpl)
            zsh -n "$rendered_file"
            ;;
          *.sh.tmpl)
            bash -n "$rendered_file"
            zsh -n "$rendered_file"
            shellcheck -x --shell=bash "$rendered_file"
            ;;
        esac
      done
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
