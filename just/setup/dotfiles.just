# Apply chezmoi-managed dotfiles
[arg('targets', help='Optional target paths to apply')]
[group('setup')]
apply *targets: (doctor 'apply')
    chezmoi \
      --source {{ quote(repo_dir) }} \
      --refresh-externals=auto \
      {{ quote(if targets { ['apply', targets] } else { ['init', '--apply'] }) }}

# Preview pending chezmoi-managed dotfile changes without refreshing externals
[group('setup')]
dotfiles-diff: (doctor 'apply')
    chezmoi \
      --source {{ quote(repo_dir) }} \
      --refresh-externals=never \
      diff

# Apply Helium extensions, settings, and the Catppuccin Custom themes
[group('setup')]
helium: (doctor 'reconcile')
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
    ansible/bootstrap.py run --tags helium

# Prepare or repair the dependencies needed to run Ansible
[group('setup')]
[positional-arguments]
bootstrap *args:
    ansible/bootstrap.py bootstrap "$@"

[doc('Install userland, apply dotfiles, then configure the host.')]
[group('setup')]
[positional-arguments]
setup *args:
    ansible/bootstrap.py setup "$@"

# Refresh userland, dotfiles, and host stages on an already-bootstrapped machine
[group('setup')]
update:
    DOTFILES_HOMEBREW_UPGRADE=1 ansible/bootstrap.py setup

_deps:
    uv run ansible-galaxy collection install {{ if !path_exists('.ansible/collections/ansible_collections/community/general/MANIFEST.json') || !path_exists('.ansible/collections/ansible_collections/community/sops/MANIFEST.json') { '--force' } }} \
      --requirements-file ansible/requirements.yml

# Run selected Ansible tasks with the installed runtime
[group('setup')]
[positional-arguments]
ansible *args:
    ansible/bootstrap.py run "$@"
