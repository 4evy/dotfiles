# Format the repository and any available encrypted records through treefmt.
[group('dev')]
fmt: (doctor 'fmt')
    records_ready=0

    pack_records() {
      exit_status=$?
      trap - EXIT
      if ((records_ready)); then
        {{ just_command }} records-pack || {
          pack_status=$?
          printf 'Failed to repack encrypted records; plaintext remains materialized.\n' >&2
          exit "$pack_status"
        }
      fi
      exit "$exit_status"
    }
    trap pack_records EXIT

    if [[ -f .records-unpacked ]]; then
      records_ready=1
    elif {{ just_command }} records-unpack; then
      records_ready=1
    else
      printf 'Skipping encrypted records because they could not be unpacked.\n' >&2
    fi

    nix fmt

    if ((records_ready)); then
      record_paths=()
      git_exclude=$(git rev-parse --git-path info/exclude)
      while IFS= read -r path; do
        path=${path#/}
        [[ -f $path && ! -L $path ]] && record_paths+=("$path")
      done < <(
        awk '
          /^# BEGIN dotfiles encrypted records$/ { copy = 1; next }
          /^# END dotfiles encrypted records$/ { copy = 0 }
          copy { print }
        ' "$git_exclude"
      )
      ((${#record_paths[@]} == 0)) || nix fmt -- "${record_paths[@]}"
    fi

# Rerun a recipe when files change.
[arg('args', help='Recipe and arguments to rerun on file changes')]
[group('dev')]
watch +args=['check']: (doctor 'watch')
    watchexec --clear --restart -- {{ just_command }} {{ quote(args) }}

# Run the same treefmt wrapper in CI mode without retaining rewrites.
[group('check')]
check-format: (doctor 'fmt')
    nix fmt -- --ci
