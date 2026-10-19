# Keep command modules on the same shell, environment, and helper conventions
set minimum-version := "1.58.0"
set unstable
set lists
set lazy
set default-script
set shell := ['bash', '-euo', 'pipefail', '-c']
set script-interpreter := ['bash', '-euo', 'pipefail']

# Recipe shells must keep this file's PATH instead of reloading shell startup
unexport BASH_ENV

podman := split(env("PODMAN", "podman"))
host_os := os()
repo_dir := justfile_directory()
[private]
just_command := quote([just_executable(), "--justfile", justfile()])

homebrew_prefix := env("HOMEBREW_PREFIX", if host_os == "macos" { "/opt/homebrew" } else { "/home/linuxbrew/.linuxbrew" })
homebrew_gnu_formulae := ['coreutils', 'findutils', 'gnu-sed', 'grep', 'gawk', 'gnu-tar', 'gnu-which', 'diffutils', 'make']
homebrew_gnu_path := if host_os == "macos" { homebrew_prefix / "opt" / homebrew_gnu_formulae / "libexec/gnubin" }
homebrew_path := homebrew_prefix / ["bin", "sbin"]
nix_bin_dir := "/nix/var/nix/profiles/default/bin"
nix_profile_bin_dir := home_directory() / ".nix-profile/bin"
nixos_profile_bin_dir := "/run/current-system/sw/bin"
hjem_state_home := if env("XDG_STATE_HOME", "") == "" { home_directory() / ".local/state" } else { env("XDG_STATE_HOME") }
hjem_path := if host_os == "linux" && !path_exists('/etc/NIXOS') { [hjem_state_home / "hjem/standalone/current-profile/bin"] } else { [] }

# Keep activated runtimes ahead of fallback tools and add GNU utilities locally
export PATH := if env("CI", "") == "true" { env("PATH", "") } else { join_list([homebrew_gnu_path, hjem_path, env("PATH", ""), homebrew_path, nix_bin_dir, nix_profile_bin_dir, nixos_profile_bin_dir], PATH_VAR_SEP) }
# Dependency changes must be made explicitly with uv outside the task runner
export UV_LOCKED := "1"

# Preserve Git's NUL delimiters, including newlines in filenames
nul_split(output) := if output == '' { [] } else { split(trim_end_match(output, "\u{0}"), "\u{0}") }
git_files(patterns) := nul_split(shell('git ls-files -z --deduplicate --cached --others --exclude-standard -- ' + join_list(quote(patterns))))

[shell]
_run executable +arguments:
    {{ quote([executable, arguments]) }}

_run-files executable patterns arguments=[]:
    printf '==> %s\n' {{ quote(join_list([executable, arguments])) }}
    files=()
    for file in {{ quote(git_files(patterns)) }}; do
      [[ -f $file && ! -L $file ]] && files+=("$file")
    done
    ((${#files[@]} == 0)) || {{ quote([executable, arguments]) }} "${files[@]}"

doctor_setup_commands := ['python3', 'bash', 'curl', 'git', 'sudo']
doctor_format_commands := ['git', 'nix']
doctor_lint_commands := ['actionlint', 'deadnix', 'diffstat', 'go', 'golangci-lint', 'jq', 'luacheck', 'nix-instantiate', 'rumdl', 'shellcheck', 'statix', 'taplo', 'zizmor', 'zsh'] ++ (if host_os == "linux" { ['hadolint'] }) ++ doctor_format_commands ++ ['uv', 'yamllint']
[private]
doctor_sops_commands := ['bash', 'sops'] ++ (if host_os == "macos" { ['op'] })
[private]
doctor_records_commands := doctor_sops_commands ++ ['git', 'go']
doctor_all_commands := doctor_lint_commands ++ doctor_sops_commands ++ ['bun', 'curl', 'shfmt', 'sudo', 'watchexec']

doctor_commands(profile) := if profile == 'status' { if host_os == 'linux' { ['bootc', 'sudo'] } } else if profile == 'reboot' { if host_os == 'linux' { ['systemctl'] } } else if profile == 'install' { if host_os == 'linux' { ['bootc', 'sudo'] } } else if profile == 'spectrum' { ['bluebuild', 'check-jsonschema', 'jq', 'skopeo', 'uv'] } else if profile == 'setup' { doctor_setup_commands } else if profile == 'reconcile' { ['python3', 'bash'] } else if profile == 'apply' { ['bun', 'nix', 'jq', 'python3'] ++ doctor_records_commands } else if profile == 'records' { doctor_records_commands } else if profile == 'sops' { doctor_sops_commands } else if profile == 'shell' { ['shellcheck', 'shfmt'] } else if profile == 'fmt' { doctor_format_commands } else if profile == 'lint' || profile == 'check' { doctor_lint_commands } else if profile == 'bun' { ['bun'] } else if profile == 'nix' { ['bash', 'curl', 'jq', 'sudo'] } else if profile == 'watch' { ['watchexec'] } else if profile == 'all' { doctor_all_commands ++ (if host_os == 'linux' { ['bootc', 'systemctl'] }) }

# Check one workflow's commands, or every workflow when omitted.
[arg('profile', pattern=['status', 'reboot', 'install', 'build', 'setup', 'reconcile', 'apply', 'records', 'sops', 'shell', 'spectrum', 'fmt', 'lint', 'bun', 'nix', 'watch', 'check', 'all'], help='Workflow to check')]
[group('system')]
_doctor $profile="all":
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
