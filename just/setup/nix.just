determinate_nix_installer_url := "https://install.determinate.systems/nix"
determinate_nix_pkg_url := "https://install.determinate.systems/determinate-pkg/stable/Universal"
determinate_nix_team_id := "X3JQ4VPJZ6"
nix_bin := nix_bin_dir / "nix"

# Install Nix on Linux, accounting for immutable composefs hosts.
[linux]
_ensure-nix:
    if [[ ! -e /nix ]] &&
      command -v rpm-ostree >/dev/null 2>&1 &&
      findmnt --noheadings --output SOURCE,FSTYPE,OPTIONS / | grep -Eq '(^|[[:space:]])composefs([[:space:]]|$)'; then
      printf '%s\n' 'This composefs ostree host needs /nix in the booted image before installing Nix.' >&2
      printf '%s\n' 'Rebuild and boot Spectrum with the /nix mountpoint, then rerun just nix.' >&2
      exit 1
    fi

    if ! command -v nix >/dev/null 2>&1; then
      plan=linux
      if command -v rpm-ostree >/dev/null 2>&1; then
        plan=ostree
      fi
      curl --proto '=https' --tlsv1.2 -fsSL {{ quote(determinate_nix_installer_url) }} |
        sh -s -- install "$plan" --determinate --no-confirm --no-modify-profile
    fi

# Install the signed, notarized Determinate package recommended for macOS.
[macos]
_ensure-nix:
    if ! command -v nix >/dev/null 2>&1; then
      scratch=$(mktemp -d "${TMPDIR:-/tmp}/determinate.XXXXXXXXXX")
      trap 'rm -rf "$scratch"' EXIT
      pkg="$scratch/Determinate.pkg"

      curl --proto '=https' --tlsv1.2 -fsSL \
        {{ quote(determinate_nix_pkg_url) }} \
        --output "$pkg"
      signature=$(spctl -a -vv -t install "$pkg" 2>&1)
      actual_team_id=$(awk -F '[()]' '/origin=/ { print $(NF - 1) }' <<<"$signature")
      if [[ $actual_team_id != {{ quote(determinate_nix_team_id) }} ]]; then
        printf 'Determinate.pkg Team ID mismatch: expected %s, got %s\n' \
          {{ quote(determinate_nix_team_id) }} "${actual_team_id:-unknown}" >&2
        exit 1
      fi
      sudo /usr/sbin/installer -verboseR -pkg "$pkg" -tgt /
    fi

# Show the installed distribution, enabled features, and daemon status.
[group('system')]
determinate-status: (doctor 'nix') _ensure-nix
    nix --version
    determinate-nixd version
    determinate-nixd status

# Upgrade installer-managed Determinate Nix (NixOS is updated through its flake lock).
[confirm('Upgrade this installer-managed Determinate Nix installation?')]
[group('system')]
determinate-upgrade: (doctor 'nix') _ensure-nix
    : {{ assert(!path_exists('/etc/NIXOS'), 'NixOS manages Determinate declaratively; update flake.lock and rebuild instead.') }}
    sudo determinate-nixd upgrade

# Replace incorrect Nix expression hashes, prompting before each edit by default.
[arg('args', help='Arguments forwarded to determinate-nixd fix hashes')]
[group('dev')]
determinate-fix-hashes *args: (doctor 'nix') _ensure-nix
    determinate-nixd fix hashes {{ quote(args) }}

# Install Nix and reconcile only the repository-owned tool bundle.
[group('setup')]
nix: (doctor 'nix') _ensure-nix
    if [[ -e /etc/NIXOS ]]; then
      printf '%s\n' 'NixOS owns these tools; update the flake and rebuild the system to upgrade them.'
      exit 0
    fi

    nix_bin={{ quote(which(nix_bin) || 'nix') }}
    installed=$("$nix_bin" profile list --json | jq -er '.elements | has("dotfiles-nix-tools") | tostring')
    if [[ $installed == false ]]; then
      "$nix_bin" profile add --priority 3 {{ quote('path:' + repo_dir + '#dotfiles-nix-tools') }}
    fi
    "$nix_bin" profile upgrade dotfiles-nix-tools
