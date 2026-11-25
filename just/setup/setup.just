import '../module.just'

# Prepare Homebrew (and uv on macOS) without configuring the workstation
[group('setup')]
[positional-arguments]
bootstrap *args:
    tools/setup/setup.sh bootstrap "$@"

# Provision the workstation, then apply the Hjem home generation
[default]
[group('setup')]
[positional-arguments]
run *args:
    tools/setup/setup.sh setup "$@"

# Upgrade the Homebrew bundle and refresh the workstation and Hjem
[env('DOTFILES_HOMEBREW_UPGRADE', '1')]
[group('setup')]
update:
    tools/setup/setup.sh setup

# Build and activate the macOS system configuration
[group('setup')]
[macos]
darwin:
    tools/setup/setup.sh setup --only host

# Inspect macOS TCC, reconcile notifications, or explicitly opt into TCC inserts
[group('setup')]
[macos]
[positional-arguments]
permissions *args:
    # Keep the tools rooted while sudo is waiting for credentials
    tools="${0%/*}/tools"
    nix build --no-write-lock-file --out-link "$tools" \
      {{ quote(repo_dir + '#dotfiles-typescript-tools') }}
    sudo /usr/bin/env DOTFILES_REPO={{ quote(repo_dir) }} \
      "$tools/bin/dotfiles-permissions" --user "$(id -un)" "$@"
