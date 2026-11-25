import '../module.just'

set default-list
# Preview pending Hjem-managed home changes
[group('setup')]
diff: (_doctor 'apply')
    bun {{ quote(repo_dir / 'home/deploy/apply.ts') }} diff

# Activate the complete Hjem-managed home generation
[group('setup')]
apply: (_doctor 'apply')
    bun {{ quote(repo_dir / 'home/deploy/apply.ts') }} apply

# Apply Helium extensions, settings, and the Catppuccin Custom themes
[group('setup')]
helium: (_doctor 'reconcile')
    readonly helium_quit_attempts=30
    readonly helium_quit_poll_seconds=1
    if [[ {{ quote(host_os) }} == macos ]]; then
      if pgrep -f '^/Applications/Helium[.]app/Contents/MacOS/Helium([[:space:]]|$)' >/dev/null; then
        osascript -e 'tell application "Helium" to quit'
      fi
      for ((attempt = 1; attempt <= helium_quit_attempts; attempt++)); do
        pgrep -f '^/Applications/Helium[.]app/Contents/MacOS/Helium([[:space:]]|$)' >/dev/null || break
        sleep "$helium_quit_poll_seconds"
      done
      if pgrep -f '^/Applications/Helium[.]app/Contents/MacOS/Helium([[:space:]]|$)' >/dev/null; then
        echo 'Helium did not quit; profile settings cannot be applied' >&2
        exit 1
      fi
    else
      pkill -TERM -x helium || true
      for ((attempt = 1; attempt <= helium_quit_attempts; attempt++)); do
        pgrep -x helium >/dev/null || break
        sleep "$helium_quit_poll_seconds"
      done
      if pgrep -x helium >/dev/null; then
        echo 'Helium did not quit; profile settings cannot be applied' >&2
        exit 1
      fi
    fi
    bun home/applications/helium/apply.ts
