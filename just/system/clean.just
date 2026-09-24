# Reclaim disposable Podman, Nix, tool, user, and journal data.
[confirm('Remove unused Podman data, old Nix generations, caches, and archived journals?')]
[group('system')]
[linux]
clean:
    cache_dir={{ quote(cache_directory()) }}
    home_dir={{ quote(home_directory()) }}
    tracked_paths=(/var "$home_dir" /nix /run "$cache_dir")

    filesystem_usage_bytes() {
      local path filesystem used total=0
      local -A seen_filesystems=()
      for path in "${tracked_paths[@]}"; do
        [[ -e $path ]] || continue
        read -r filesystem used < <(
          df --block-size=1 --output=source,used -- "$path" | tail -n 1
        )
        [[ -v seen_filesystems[$filesystem] ]] && continue
        seen_filesystems[$filesystem]=1
        total=$((total + used))
      done
      printf '%s\n' "$total"
    }

    human_bytes() {
      if command -v numfmt >/dev/null 2>&1; then
        numfmt --to=iec-i --suffix=B "$1"
      else
        printf '%s bytes\n' "$1"
      fi
    }

    report_usage_delta() {
      local delta=$1 context=$2
      if ((delta >= 0)); then
        printf 'Actual filesystem space reclaimed: %s (%s bytes)\n' "$(human_bytes "$delta")" "$delta"
      else
        delta=$((-delta))
        printf 'Filesystem usage grew during %s: %s (%s bytes)\n' "$context" "$(human_bytes "$delta")" "$delta"
      fi
    }

    measure_cleanup() {
      local label=$1
      shift
      local before after reclaimed
      sync
      before=$(filesystem_usage_bytes)
      printf '\n==> %s\n' "$label"
      if ! "$@"; then
        printf 'Cleanup stage failed: %s\n' "$label" >&2
        return 1
      fi
      sync
      after=$(filesystem_usage_bytes)
      reclaimed=$((before - after))
      report_usage_delta "$reclaimed" 'this stage'
    }

    clean_podman() {
      {{ quote(podman) }} system prune --all --force |
        sed 's/^Total reclaimed space:/Podman logical reclaimed total (not physical disk usage):/'
    }

    clean_podman_root() {
      # Rootful Podman performs Spectrum builds. Failed commits can leave
      # Buildah working containers behind, and ordinary system prune does not
      # remove them without --build.
      sudo {{ quote(podman) }} system prune --force --build |
        sed 's/^Total reclaimed space:/Podman logical reclaimed total (not physical disk usage):/'
    }

    clean_buildah_caches() {
      local buildah_tmp=/var/tmp
      # Persistent cache mounts and interrupted layer commits live outside the
      # containers-storage graph, so Podman's prune cannot account for them.
      sudo find "$buildah_tmp" -mindepth 1 -maxdepth 1 -name 'buildah*' \
        -exec rm -rf -- {} + ||
        printf 'Some active Buildah temporary paths could not be removed.\n' >&2
    }

    clean_nix() {
      nh clean all --keep 1
    }

    clean_tool_caches() {
      if command -v uv >/dev/null 2>&1; then
        if ! uv cache prune --force; then
          printf 'uv cache prune failed; the full user-cache cleanup will retry it.\n' >&2
        fi
      fi
      if command -v go >/dev/null 2>&1; then
        go clean -cache
      fi
      if command -v brew >/dev/null 2>&1; then
        brew cleanup --prune=all -s
      fi
    }

    clean_user_cache() {
      case "$cache_dir" in
        '' | / | "$home_dir")
          printf 'Refusing unsafe cache directory: %q\n' "$cache_dir" >&2
          exit 2
          ;;
      esac
      if [[ -d $cache_dir ]]; then
        if ! find "$cache_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; then
          printf 'Retrying user-cache cleanup with elevated privileges.\n' >&2
          sudo find "$cache_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
        fi
      fi
    }

    clean_journal() {
      journal_size_kib=0
      for journal_dir in /var/log/journal /run/log/journal; do
        if [[ -d $journal_dir ]]; then
          directory_size_kib=$(sudo du -sk "$journal_dir" | awk '{ print $1 }')
          journal_size_kib=$((journal_size_kib + directory_size_kib))
        fi
      done
      journal_threshold_kib=$((1024 * 1024))

      if ((journal_size_kib > journal_threshold_kib)); then
        sudo journalctl --rotate
        sudo journalctl --vacuum-size=500M
      else
        printf 'Journal uses at most 1 GiB; skipping cleanup.\n'
      fi
    }

    sync
    total_before=$(filesystem_usage_bytes)
    measure_cleanup 'Rootless Podman' clean_podman
    measure_cleanup 'Rootful Podman' clean_podman_root
    measure_cleanup 'Buildah temporary caches' clean_buildah_caches
    measure_cleanup 'Nix generations and store' clean_nix
    measure_cleanup 'Tool caches' clean_tool_caches
    measure_cleanup 'User cache' clean_user_cache
    measure_cleanup 'Archived journals' clean_journal
    sync
    total_after=$(filesystem_usage_bytes)
    total_reclaimed=$((total_before - total_after))
    printf '\n==> Cleanup total\n'
    report_usage_delta "$total_reclaimed" cleanup
