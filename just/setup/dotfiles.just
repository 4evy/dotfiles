# Activate the complete Hjem-managed home generation
[group('setup')]
apply: (_doctor 'apply')
    bun {{ quote(repo_dir / 'scripts/hjem/hjem.ts') }} apply

# Apply Helium extensions, settings, and the Catppuccin Custom themes
[group('setup')]
helium: (_doctor 'reconcile')
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "$(uname)" = Darwin ]; then
      if pgrep -f '^/Applications/Helium[.]app/Contents/MacOS/Helium([[:space:]]|$)' >/dev/null; then
        osascript -e 'tell application "Helium" to quit'
      fi
      for attempt in $(seq 1 30); do
        pgrep -f '^/Applications/Helium[.]app/Contents/MacOS/Helium([[:space:]]|$)' >/dev/null || break
        sleep 1
      done
      if pgrep -f '^/Applications/Helium[.]app/Contents/MacOS/Helium([[:space:]]|$)' >/dev/null; then
        echo 'Helium did not quit; profile settings cannot be applied' >&2
        exit 1
      fi
    else
      pkill -TERM -x helium || true
      for attempt in $(seq 1 30); do
        pgrep -x helium >/dev/null || break
        sleep 1
      done
      if pgrep -x helium >/dev/null; then
        echo 'Helium did not quit; profile settings cannot be applied' >&2
        exit 1
      fi
    fi
    bun scripts/setup/applications.ts helium

# Prepare Homebrew and uv for workstation setup
[group('setup')]
[positional-arguments]
bootstrap *args:
    scripts/setup/setup.sh bootstrap "$@"

[doc('Install userland, apply dotfiles, then configure the host.')]
[group('setup')]
[positional-arguments]
setup *args:
    scripts/setup/setup.sh setup "$@"

# Refresh userland, dotfiles, and host stages on an already-bootstrapped machine
[group('setup')]
update:
    DOTFILES_HOMEBREW_UPGRADE=1 scripts/setup/setup.sh setup

# Build and activate the macOS system configuration
[group('setup')]
[macos]
darwin:
    scripts/setup/setup.sh setup --only host
