import '../common.just'

set working-directory := '../..'
# Render every supported host variant and validate the generated home files
[group('check')]
check: _secrets *(_hjem-platform *['darwin', 'fedora', 'nixos'])

_secrets:
    {{ just_command }} sops check

_hjem-platform platform:
    bun scripts/check/hjem.ts {{ quote(platform) }}
# Build or activate the Hjem home environment
[arg('action', help='switch to activate, or build to prepare without activating')]
[group('setup')]
_activate action:
    case {{ quote(action) }} in
      switch|build) ;;
      *) printf '%s\n' 'Expected switch or build' >&2; exit 2 ;;
    esac
    if [[ $(uname) == Linux && ! -e /etc/NIXOS ]]; then
      {{ quote(repo_dir / 'scripts/hjem/hjem.sh') }} {{ quote('packages-' + action) }}
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

# Activate the complete Hjem home environment
[default]
switch: (_activate 'switch')

# Prepare the Hjem home environment without activating it
build: (_activate 'build')
