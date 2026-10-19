determinate_nix_installer_url := "https://install.determinate.systems/nix"
determinate_nix_pkg_url := "https://install.determinate.systems/determinate-pkg/stable/Universal"
determinate_nix_team_id := "X3JQ4VPJZ6"
nix_bin := nix_bin_dir / "nix"

# Install Nix on Linux, accounting for immutable composefs hosts
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

# Install the signed, notarized Determinate package recommended for macOS
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

# Show the installed distribution, enabled features, and daemon status
[group('system')]
determinate-status: (doctor 'nix') _ensure-nix
    nix --version
    determinate-nixd version
    determinate-nixd status

# Upgrade installer-managed Determinate Nix (NixOS is updated through its flake lock)
[confirm('Upgrade this installer-managed Determinate Nix installation?')]
[group('system')]
determinate-upgrade: (doctor 'nix') _ensure-nix
    : {{ assert(!path_exists('/etc/NIXOS'), 'NixOS manages Determinate declaratively; update flake.lock and rebuild instead.') }}
    sudo determinate-nixd upgrade

# Replace incorrect Nix expression hashes, prompting before each edit by default
[arg('args', help='Arguments forwarded to determinate-nixd fix hashes')]
[group('dev')]
determinate-fix-hashes *args: (doctor 'nix') _ensure-nix
    determinate-nixd fix hashes {{ quote(args) }}

# Update selected inputs, or all inputs
[arg('inputs', help='Input names to update; omit to update all')]
[group('dev')]
nix-update *inputs: (doctor 'nix')
    nix flake update {{ quote(inputs) }}

# Install Nix and activate the Linux user environment through Hjem
[group('setup')]
nix: (doctor 'nix') _ensure-nix
    if [[ $(uname) == Darwin ]]; then
      printf '%s\n' 'Darwin owns these tools, use just darwin to rebuild them.'
      exit 0
    fi
    if [[ -e /etc/NIXOS ]]; then
      printf '%s\n' 'NixOS owns these tools, rebuild the system to upgrade them.'
      exit 0
    fi
    {{ just_command }} hjem

# Build or activate the Hjem home environment
[arg('action', help='switch to activate, or build to prepare without activating')]
[group('setup')]
hjem action='switch':
    case {{ quote(action) }} in
      switch|build) ;;
      *) printf '%s\n' 'Expected switch or build' >&2; exit 2 ;;
    esac
    if [[ $(uname) == Linux && ! -e /etc/NIXOS ]]; then
      nix run {{ quote(repo_dir + '#hjem') }} -- standalone {{ quote(action) }} \
        --flake {{ quote(repo_dir) }} --flake-attr hjemConfigurations.linux --impure
    fi
    {{ quote(repo_dir / 'scripts/hjem/hjem.sh') }} {{ quote(if action == 'switch' { 'apply' } else { 'build' }) }}
    if [[ {{ quote(action) }} == switch && $(uname) == Linux && ! -e /etc/NIXOS ]]; then
      profile="${XDG_STATE_HOME:-$HOME/.local/state}/hjem/standalone/current-profile"
      if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        systemctl --user daemon-reload
        # Imported manager values can outlive environment generator reloads
        if command -v busctl >/dev/null 2>&1; then
          manager_environment=$(busctl --user --json=short get-property \
            org.freedesktop.systemd1 /org/freedesktop/systemd1 \
            org.freedesktop.systemd1.Manager Environment | \
            "$profile/bin/jq" -r '.data[] | select(test("^(PATH|XDG_DATA_DIRS|MANPATH|INFOPATH)="))')
          manager_path=$PATH
          manager_data=${XDG_DATA_DIRS:-/usr/local/share:/usr/share}
          manager_man=${MANPATH:-}
          manager_info=${INFOPATH:-}
          while IFS= read -r entry; do
            case "$entry" in
              PATH=*) manager_path=${entry#PATH=} ;;
              XDG_DATA_DIRS=*) manager_data=${entry#XDG_DATA_DIRS=} ;;
              MANPATH=*) manager_man=${entry#MANPATH=} ;;
              INFOPATH=*) manager_info=${entry#INFOPATH=} ;;
            esac
          done <<< "$manager_environment"
          case ":$manager_path:" in
            *":$profile/bin:"*) ;;
            *) manager_path="$profile/bin:$manager_path" ;;
          esac
          case ":$manager_data:" in
            *":$profile/share:"*) ;;
            *) manager_data="$profile/share:$manager_data" ;;
          esac
          case ":$manager_man:" in
            *":$profile/share/man:"*) ;;
            *) manager_man="$profile/share/man:$manager_man" ;;
          esac
          case ":$manager_info:" in
            *":$profile/share/info:"*) ;;
            *) manager_info="$profile/share/info:$manager_info" ;;
          esac
          systemctl --user set-environment \
            "PATH=$manager_path" "XDG_DATA_DIRS=$manager_data" \
            "MANPATH=$manager_man" "INFOPATH=$manager_info"
        fi
      fi
      if command -v fc-cache >/dev/null 2>&1; then
        fc-cache
      fi
    fi
