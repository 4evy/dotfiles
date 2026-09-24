import 'system/clean.just'

doctor_setup_commands := ['bash', 'curl', 'git', 'sudo']
doctor_format_commands := ['git', 'nix']
doctor_ansible_commands := ['ansible-doc', 'ansible-galaxy', 'ansible-lint', 'ansible-playbook', 'yamllint']
doctor_lint_commands := ['actionlint', 'bundle', 'chezmoi', 'deadnix', 'diffstat', 'go', 'golangci-lint', 'jq', 'luacheck', 'nix-instantiate', 'ruby', 'rumdl', 'shellcheck', 'statix', 'taplo', 'uv', 'zizmor'] ++ (if host_os == "linux" { ['hadolint'] }) ++ doctor_format_commands ++ doctor_ansible_commands
[private]
doctor_sops_commands := ['bash', 'sops'] ++ (if host_os == "macos" { ['op'] })
[private]
doctor_records_commands := doctor_sops_commands ++ ['git', 'go']
doctor_all_commands := doctor_lint_commands ++ doctor_sops_commands ++ ['bun', 'curl', 'shfmt', 'sudo', 'watchexec']

doctor_commands(profile) := if profile == 'status' { if host_os == 'linux' { ['bootc', 'sudo'] } } else if profile == 'reboot' { if host_os == 'linux' { ['systemctl'] } } else if profile == 'install' { if host_os == 'linux' { ['bootc', 'sudo'] } } else if profile == 'spectrum' { ['bluebuild', 'check-jsonschema', 'jq', 'skopeo'] } else if profile == 'setup' { doctor_setup_commands } else if profile == 'apply' { ['chezmoi', 'jq', 'ruby', doctor_records_commands] } else if profile == 'records' { doctor_records_commands } else if profile == 'sops' { doctor_sops_commands } else if profile == 'shell' { ['shellcheck', 'shfmt'] } else if profile == 'fmt' { doctor_format_commands } else if profile == 'lint' || profile == 'check' { doctor_lint_commands } else if profile == 'ansible' { doctor_ansible_commands } else if profile == 'bun' { ['bun'] } else if profile == 'nix' { ['bash', 'curl', 'sudo'] } else if profile == 'watch' { ['watchexec'] } else if profile == 'all' { doctor_all_commands ++ (if host_os == 'linux' { ['bootc', 'systemctl'] }) }

# Check one workflow's commands, or every workflow when omitted.
[arg('profile', pattern=['status', 'reboot', 'install', 'build', 'setup', 'apply', 'records', 'sops', 'shell', 'spectrum', 'fmt', 'lint', 'ansible', 'bun', 'nix', 'watch', 'check', 'all'], help='Workflow to check')]
[group('system')]
doctor $profile="all":
    host_os={{ quote(host_os) }}
    commands=({{ quote(doctor_commands(profile)) }})
    podman_command=({{ quote(podman) }})

    if [[ $host_os != linux && $profile =~ ^(status|reboot|install)$ ]]; then
      printf 'Skipping Linux-only dependency check for workflow %q on %s.\n' "$profile" "$host_os"
      exit
    fi
    if [[ $host_os == linux && $profile =~ ^(build|spectrum|all)$ ]]; then
      commands+=("${podman_command[0]}")
    fi

    missing=0
    for command in "${commands[@]}"; do
      if ! command -v "$command" >/dev/null 2>&1; then
        printf 'missing command: %s\n' "$command" >&2
        missing=1
      fi
    done
    if ((missing)); then
      printf 'Install the missing commands, then rerun `just doctor %q`.\n' "$profile" >&2
      exit 1
    fi
    printf 'Ready: all commands for the %s workflow are available.\n' "$profile"

# Show bootc and image metadata status.
[group('system')]
[linux]
[shell]
status: (doctor 'status')
    sudo bootc status
    @if [ -r /usr/share/ublue-os/image-info.json ] && command -v jq >/dev/null 2>&1; then \
      jq . /usr/share/ublue-os/image-info.json; \
    fi

# Reboot the host.
[confirm('Reboot this host now?')]
[group('system')]
[linux]
reboot: (doctor 'reboot')
    systemctl reboot
