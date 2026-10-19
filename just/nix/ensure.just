# Shared installer prerequisite for Nix and Determinate commands
determinate_nix_installer_url := "https://install.determinate.systems/nix"
determinate_nix_pkg_url := "https://install.determinate.systems/determinate-pkg/stable/Universal"
determinate_nix_team_id := "X3JQ4VPJZ6"

# Install Nix on Linux, accounting for immutable composefs hosts
[linux]
_ensure:
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

# Install the signed, notarized Determinate package recommended for macOS
[macos]
_ensure:
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
