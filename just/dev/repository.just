[parallel]
_lint-files: _check-worktree-paths _lint-chezmoi-source (_run-files 'jq' ['*.json', 'flake.lock', ':(exclude).vscode/settings.json'] ['empty']) _lint-container-files (_run-files 'luacheck' ['*.lua']) (_run 'rumdl' ['check', '--respect-gitignore', '.']) _lint-nix (_run 'uv' ['run', 'ruff', 'check', '.']) _lint-shell-files _lint-shell-templates-portable _lint-templates (_run-files 'taplo' ['*.toml'] ['lint']) _lint-xml

[linux]
_lint-container-files: (_run-files 'hadolint' ['Dockerfile', 'Containerfile'])

[macos]
_lint-container-files:

_check-worktree-paths:
    broken=0
    for file in {{ quote(git_files([])) }}; do
      if [[ -L $file && ! -e $file ]]; then
        target=$(readlink "$file")
        if [[ $file == bluebuild/files/system/* && $target == /* && -e bluebuild/files/system$target ]]; then
          continue
        fi
        printf 'broken symlink: %s\n' "$file" >&2
        broken=1
      elif [[ ! -e $file ]]; then
        printf 'tracked path missing from worktree: %s\n' "$file" >&2
      fi
    done
    exit "$broken"

_lint-chezmoi-source: sops-check
    temporary_dir=$(mktemp -d)
    trap 'rm -rf "$temporary_dir"' EXIT
    chezmoi_executable=$(command -v chezmoi)
    render_path=$PATH
    records_age_key_file=${SOPS_AGE_KEY_FILE:-}
    if [[ -z $records_age_key_file && -f $HOME/.config/sops/age/keys.txt ]]; then
      records_age_key_file=$HOME/.config/sops/age/keys.txt
    fi
    managed_source_paths="$temporary_dir/managed-source-paths"
    managed_target_paths="$temporary_dir/managed-target-paths"
    platforms=(
      'darwin|{"chezmoi":{"os":"darwin","arch":"arm64","osRelease":{}}}'
      'fedora|{"chezmoi":{"os":"linux","arch":"amd64","osRelease":{"id":"fedora"}}}'
      'nixos|{"chezmoi":{"os":"linux","arch":"amd64","osRelease":{"id":"nixos"}}}'
      'windows|{"chezmoi":{"os":"windows","arch":"amd64","osRelease":{}}}'
    )
    : > "$managed_source_paths"
    : > "$managed_target_paths"
    invalid=0
    for platform in "${platforms[@]}"; do
      platform_name=${platform%%|*}
      platform_override=${platform#*|}
      destination="$temporary_dir/home-$platform_name"
      platform_config_home="$temporary_dir/config-$platform_name"
      config_file="$platform_config_home/chezmoi/chezmoi.toml"
      persistent_state="$platform_config_home/chezmoi/chezmoi.boltdb"
      render_stderr="$temporary_dir/$platform_name-render-stderr"
      mkdir -p "$destination"
      chezmoi_for_platform() {
        HOME="$destination" \
        DOTFILES_RECORDS_HOST_OS={{ quote(if host_os == "macos" { "darwin" } else { host_os }) }} \
        PATH="$render_path" \
        SOPS_AGE_KEY_FILE="$records_age_key_file" \
        "$chezmoi_executable" \
          --config "$config_file" \
          --destination "$destination" \
          --persistent-state "$persistent_state" \
          --override-data "$platform_override" \
          --no-tty \
          --refresh-externals=never \
          "$@"
      }
      chezmoi_for_platform init --source {{ quote(repo_dir) }}
      chezmoi_for_platform dump-config --format=json | jq -e \
        '.umask == 18
          and .add.secrets == "error"
          and .add.templateSymlinks == true
          and .edit.apply == false
          and .edit.hardlink == true
          and .edit.watch == true' >/dev/null
      chezmoi_for_platform \
        managed --path-style=source-relative >> "$managed_source_paths"
      chezmoi_for_platform managed >> "$managed_target_paths"
      if ! chezmoi_for_platform \
        apply --force --exclude encrypted,scripts,externals \
        >/dev/null 2> "$render_stderr"; then
        cat "$render_stderr" >&2
        invalid=1
      elif [[ -s $render_stderr ]]; then
        printf 'chezmoi render warning for %s:\n' "$platform_name" >&2
        cat "$render_stderr" >&2
        invalid=1
      elif ! chezmoi_for_platform \
        verify --exclude scripts,externals; then
        printf 'chezmoi verification failed for %s after an isolated apply\n' \
          "$platform_name" >&2
        invalid=1
      fi
    done
    sort -u -o "$managed_source_paths" "$managed_source_paths"
    sort -u -o "$managed_target_paths" "$managed_target_paths"

    source_only_entries=(README.md package.json tsconfig.json)
    for source_entry in "${source_only_entries[@]}"; do
      if grep -Fqx -- "$source_entry" "$managed_target_paths"; then
        printf 'chezmoi manages source-only workspace file: dotfiles/%s\n' \
          "$source_entry" >&2
        invalid=1
      fi
    done

    records_local_excludes="$temporary_dir/records-local-excludes"
    : > "$records_local_excludes"
    if [[ -f .records-unpacked ]]; then
      git_exclude=$(git rev-parse --git-path info/exclude)
      awk '
        /^# BEGIN dotfiles encrypted records$/ { copy = 1; next }
        /^# END dotfiles encrypted records$/ { copy = 0 }
        copy { print }
      ' "$git_exclude" > "$records_local_excludes"
    fi

    while IFS= read -r -d '' ignored_source_path; do
      if grep -Fqx -- "/$ignored_source_path" "$records_local_excludes"; then
        continue
      fi
      source_entry=${ignored_source_path#dotfiles/}
      if grep -Fqx -- "$source_entry" "$managed_source_paths"; then
        printf 'chezmoi manages Git-ignored source artifact: %s\n' \
          "$ignored_source_path" >&2
        invalid=1
      fi
    done < <(
      git ls-files \
        --others \
        --ignored \
        --exclude-standard \
        -z \
        -- dotfiles
    )

    exit "$invalid"
