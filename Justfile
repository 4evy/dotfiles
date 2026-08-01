#!/usr/bin/env -S just --justfile

set default-list
set default-script
set script-interpreter := ['bash', '-euo', 'pipefail']

image_name := env("SPECTRUM_IMAGE_NAME", "spectrum")
local_ref := "localhost/" + image_name + ":latest_linux_amd64"
compose := env("COMPOSE", "podman-compose")
podman := env("PODMAN", "podman")
determinate_nix_installer_url := "https://install.determinate.systems/nix"

host_os := os()
repo_dir := justfile_directory()

homebrew_prefix := env("HOMEBREW_PREFIX", if host_os == "macos" { "/opt/homebrew" } else { "/home/linuxbrew/.linuxbrew" })
homebrew_gnu_formulae := "coreutils findutils gnu-sed grep gawk gnu-tar gnu-which diffutils make"
homebrew_gnu_path := if host_os == "macos" { replace(append("/libexec/gnubin", prepend(homebrew_prefix / "opt/", homebrew_gnu_formulae)), " ", PATH_VAR_SEP) + PATH_VAR_SEP } else { "" }
homebrew_path := homebrew_gnu_path + homebrew_prefix / "bin" + PATH_VAR_SEP + homebrew_prefix / "sbin"
nix_bin_dir := "/nix/var/nix/profiles/default/bin"
nix_bin := nix_bin_dir / "nix"
nix_profile_bin_dir := home_directory() / ".nix-profile/bin"
nixos_profile_bin_dir := "/run/current-system/sw/bin"
nix_profile_tools := "deadnix:deadnix nh:nh nil:nil nix-instantiate:nix nom:nix-output-monitor nix-tree:nix-tree nixd:nixd nixfmt:nixfmt"
pi_extension_profile_tools := "pi-ssh-tools:github:euvlok/pkgs#pi-ssh-tools web-search-pi:github:euvlok/pkgs#web-search-pi"

doctor_setup_commands := "bash curl git sudo"
doctor_format_commands := "git nix"
doctor_ansible_commands := "ansible-doc ansible-galaxy ansible-lint ansible-playbook yamllint"
doctor_lint_commands := "actionlint chezmoi deadnix hadolint jq lua luacheck nix-instantiate rumdl shellcheck taplo uv zig zizmor " + doctor_format_commands + " " + doctor_ansible_commands
doctor_all_commands := doctor_lint_commands + " bash curl sudo watchexec"

export PATH := homebrew_path + PATH_VAR_SEP + nix_bin_dir + PATH_VAR_SEP + nix_profile_bin_dir + PATH_VAR_SEP + nixos_profile_bin_dir + PATH_VAR_SEP + env("PATH", "")
# Development recipes are reproducible by default; dependency changes must be
# made explicitly with uv outside the task runner.
export UV_LOCKED := "1"

alias a := apply
alias c := check
alias cf := check-format
alias ck := check
alias f := fmt
alias l := lint
alias nx := nix
alias r := reboot
alias s := setup
alias up := update
alias w := watch

# Check commands required for a workflow profile.
[arg('profile', pattern='status|reboot|install|build|setup|apply|shell|spectrum|fmt|lint|zig|ansible|bun|smoke|nix|watch|check|all', help='status, reboot, install, build, setup, apply, shell, spectrum, fmt, lint, zig, ansible, bun, smoke, nix, watch, check, or all')]
[group('system')]
doctor profile="setup":
    profile={{ quote(profile) }}
    host_os={{ quote(host_os) }}
    commands=()
    podman_command={{ quote(podman) }}
    compose_command={{ quote(compose) }}

    linux_commands() {
      if [[ $host_os == linux ]]; then
        commands=("$@")
      else
        printf 'Skipping Linux-only dependency check for workflow %q on %s.\n' "$profile" "$host_os"
      fi
    }

    case "$profile" in
      status) linux_commands bootc ;;
      reboot) linux_commands systemctl ;;
      install) linux_commands bootc sudo ;;
      build | spectrum) commands=(bluebuild check-jsonschema jq "${podman_command%% *}" skopeo) ;;
      setup) commands=({{ doctor_setup_commands }}) ;;
      apply) commands=(chezmoi) ;;
      shell) commands=(shellcheck shfmt) ;;
      fmt) commands=({{ doctor_format_commands }}) ;;
      lint | check) commands=({{ doctor_lint_commands }}) ;;
      zig) commands=(zig) ;;
      ansible) commands=({{ doctor_ansible_commands }}) ;;
      bun) commands=(bun) ;;
      smoke) commands=("${compose_command%% *}") ;;
      nix) commands=(bash curl sudo) ;;
      watch) commands=(watchexec) ;;
      all)
        commands=({{ doctor_all_commands }} "${podman_command%% *}" "${compose_command%% *}")
        if [[ $host_os == linux ]]; then
          commands+=(bootc systemctl)
        fi
        ;;
    esac

    missing=0
    for command in "${commands[@]}"; do
      if ! command -v "$command" >/dev/null 2>&1; then
        printf 'missing command: %s\n' "$command" >&2
        missing=1
      fi
    done
    exit "$missing"

[macos]
[private]
[shell]
_linux-only recipe:
    @printf 'Skipping `just %s`: this workflow is only supported on Linux.\n' {{ quote(recipe) }}

# Show bootc and image metadata status.
[group('system')]
[linux]
[shell]
status: (doctor 'status')
    bootc status
    @if [ -r /usr/share/ublue-os/image-info.json ] && command -v jq >/dev/null 2>&1; then \
      jq . /usr/share/ublue-os/image-info.json; \
    fi

[group('system')]
[macos]
status: (_linux-only recipe_name())

# Reclaim disposable Podman, Nix, tool, user, and journal data.
[confirm('Remove unused Podman data, old Nix generations, caches, and archived journals?')]
[group('system')]
[linux]
clean:
    cache_dir={{ quote(cache_directory()) }}
    home_dir={{ quote(home_directory()) }}
    tracked_paths=(/var "$home_dir" /nix /run "$cache_dir")

    filesystem_usage_bytes() {
      local path filesystem used total=0
      local -A seen_filesystems=()
      for path in "${tracked_paths[@]}"; do
        [[ -e $path ]] || continue
        read -r filesystem used < <(
          df --block-size=1 --output=source,used -- "$path" | tail -n 1
        )
        [[ -v seen_filesystems[$filesystem] ]] && continue
        seen_filesystems[$filesystem]=1
        total=$((total + used))
      done
      printf '%s\n' "$total"
    }

    human_bytes() {
      if command -v numfmt >/dev/null 2>&1; then
        numfmt --to=iec-i --suffix=B "$1"
      else
        printf '%s bytes\n' "$1"
      fi
    }

    report_usage_delta() {
      local delta=$1 context=$2
      if ((delta >= 0)); then
        printf 'Actual filesystem space reclaimed: %s (%s bytes)\n' "$(human_bytes "$delta")" "$delta"
      else
        delta=$((-delta))
        printf 'Filesystem usage grew during %s: %s (%s bytes)\n' "$context" "$(human_bytes "$delta")" "$delta"
      fi
    }

    measure_cleanup() {
      local label=$1
      shift
      local before after reclaimed
      sync
      before=$(filesystem_usage_bytes)
      printf '\n==> %s\n' "$label"
      if ! "$@"; then
        printf 'Cleanup stage failed: %s\n' "$label" >&2
        return 1
      fi
      sync
      after=$(filesystem_usage_bytes)
      reclaimed=$((before - after))
      report_usage_delta "$reclaimed" 'this stage'
    }

    clean_podman() {
      {{ podman }} system prune --all --force |
        sed 's/^Total reclaimed space:/Podman logical reclaimed total (not physical disk usage):/'
    }

    clean_podman_root() {
      # Rootful Podman performs Spectrum builds. Failed commits can leave
      # Buildah working containers behind, and ordinary system prune does not
      # remove them without --build.
      sudo {{ podman }} system prune --force --build |
        sed 's/^Total reclaimed space:/Podman logical reclaimed total (not physical disk usage):/'
    }

    clean_buildah_caches() {
    local buildah_tmp=/var/tmp
    # Persistent cache mounts and interrupted layer commits live outside the
    # containers-storage graph, so Podman's prune cannot account for them.
    sudo find "$buildah_tmp" -mindepth 1 -maxdepth 1 -name 'buildah*' \
      -exec rm -rf -- {} + ||
      printf 'Some active Buildah temporary paths could not be removed.\n' >&2
    }

    clean_nix() {
      nh clean all --keep 1
    }

    clean_tool_caches() {
    if command -v uv >/dev/null 2>&1; then
      if ! uv cache prune --force; then
        printf 'uv cache prune failed; the full user-cache cleanup will retry it.\n' >&2
      fi
    fi
    if command -v go >/dev/null 2>&1; then
      go clean -cache -testcache
    fi
    if command -v brew >/dev/null 2>&1; then
      brew cleanup --prune=all -s
    fi
    }

    clean_user_cache() {
    case "$cache_dir" in
      '' | / | "$home_dir")
        printf 'Refusing unsafe cache directory: %q\n' "$cache_dir" >&2
        exit 2
        ;;
    esac
    if [[ -d $cache_dir ]]; then
      if ! find "$cache_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; then
        printf 'Retrying user-cache cleanup with elevated privileges.\n' >&2
        sudo find "$cache_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      fi
    fi
    }

    clean_journal() {
    journal_size_kib=0
    for journal_dir in /var/log/journal /run/log/journal; do
      if [[ -d $journal_dir ]]; then
        directory_size_kib=$(sudo du -sk "$journal_dir" | awk '{ print $1 }')
        journal_size_kib=$((journal_size_kib + directory_size_kib))
      fi
    done
    journal_threshold_kib=$((1024 * 1024))

    if ((journal_size_kib > journal_threshold_kib)); then
      sudo journalctl --rotate
      sudo journalctl --vacuum-size=500M
    else
      printf 'Journal uses at most 1 GiB; skipping cleanup.\n'
    fi
    }

    sync
    total_before=$(filesystem_usage_bytes)
    measure_cleanup 'Rootless Podman' clean_podman
    measure_cleanup 'Rootful Podman' clean_podman_root
    measure_cleanup 'Buildah temporary caches' clean_buildah_caches
    measure_cleanup 'Nix generations and store' clean_nix
    measure_cleanup 'Tool caches' clean_tool_caches
    measure_cleanup 'User cache' clean_user_cache
    measure_cleanup 'Archived journals' clean_journal
    sync
    total_after=$(filesystem_usage_bytes)
    total_reclaimed=$((total_before - total_after))
    printf '\n==> Cleanup total\n'
    report_usage_delta "$total_reclaimed" cleanup

[group('system')]
[macos]
clean: (_linux-only recipe_name())

# Reboot the host.
[confirm('Reboot this host now?')]
[group('system')]
[linux]
reboot: (doctor 'reboot')
    systemctl reboot

[group('system')]
[macos]
reboot: (_linux-only recipe_name())

# Validate the recipe and enforce the Renovate-managed base digest lock.
[group('spectrum')]
[linux]
spectrum-validate: (doctor 'spectrum')
    generated=$(mktemp)
    trap 'rm -f "$generated"' EXIT
    check-jsonschema \
      --base-uri https://schema.blue-build.org/ \
      --schemafile https://schema.blue-build.org/recipe-v2.json \
      bluebuild/recipes/spectrum.yml
    # BlueBuild's feature-gated v2 parser is ready, but its validate command
    # still hardcodes the v1 schema. The official v2 schema is checked above.
    bluebuild generate --skip-validation --output "$generated" bluebuild/recipes/spectrum.yml
    locked=$(< bluebuild/recipes/spectrum.lock)
    resolved=$(skopeo inspect "docker://${locked%@*}" | jq -r .Digest)
    [[ "$locked" == *@$resolved ]] || {
      printf 'base image lock mismatch: %s resolves to %s\n' "$locked" "$resolved" >&2
      exit 1
    }
    tagged=${locked%@*}
    expected_arg="${tagged%:*}@${locked##*@}"
    grep -Fq "ARG BASE_IMAGE=\"$expected_arg\"" "$generated"
    ! grep -qw akmods bluebuild/recipes/spectrum.yml "$generated"

[group('spectrum')]
[macos]
spectrum-validate: (_linux-only recipe_name())

# Build the local Spectrum image from the BlueBuild recipe v2 definition.
[group('spectrum')]
[linux]
spectrum-build: spectrum-validate
    bluebuild build --skip-validation --no-sign bluebuild/recipes/spectrum.yml

[group('spectrum')]
[macos]
spectrum-build: (_linux-only recipe_name())

# Inspect a built image with bootc's native container linter.
[arg('target', help='Built image reference to inspect')]
[group('spectrum')]
[linux]
spectrum-inspect target=local_ref: (doctor 'build')
    read -r -a podman_command <<< {{ quote(podman) }}
    "${podman_command[@]}" run --rm {{ quote(target) }} bootc container lint

[arg('target', help='Built image reference to inspect')]
[group('spectrum')]
[macos]
spectrum-inspect target=local_ref: (_linux-only recipe_name())

# Build the Fedora smoke-test image and run its default validation command.
[group('containers')]
smoke: (doctor 'smoke')
    read -r -a compose_command <<< {{ quote(compose) }}
    "${compose_command[@]}" build
    "${compose_command[@]}" run --rm fedora

# Open an interactive shell in the Fedora smoke-test image.
[group('containers')]
smoke-shell: (doctor 'smoke')
    read -r -a compose_command <<< {{ quote(compose) }}
    "${compose_command[@]}" run --rm fedora-shell

# Install Nix on Linux, accounting for immutable composefs hosts.
[linux]
[private]
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
      curl -fsSL {{ quote(determinate_nix_installer_url) }} | sh -s -- install "$plan" --no-confirm
    fi

# Install Determinate Nix on macOS without modifying the user's shell profile.
[macos]
[private]
_ensure-nix:
    command -v nix >/dev/null 2>&1 ||
      curl -fsSL {{ quote(determinate_nix_installer_url) }} |
        sh -s -- install macos --no-confirm --no-modify-profile

# Install Nix on the live host and ensure Nix profile tools exist.
[group('setup')]
nix: (doctor 'nix') _ensure-nix
    nix_profile_bin_dir={{ quote(nix_profile_bin_dir) }}
    nix_bin={{ quote(nix_bin) }}
    if [[ ! -x $nix_bin ]]; then
      nix_bin=$(command -v nix)
    fi

    missing=()
    for spec in {{ nix_profile_tools }} {{ pi_extension_profile_tools }}; do
      bin=${spec%%:*}
      source=${spec#*:}
      if ! command -v "$bin" >/dev/null 2>&1 &&
        [[ ! -e "$nix_profile_bin_dir/$bin" ]] &&
        [[ ! -e "/run/current-system/sw/bin/$bin" ]]; then
        if [[ $source != *'#'* ]]; then
          source="nixpkgs#$source"
        fi
        missing+=("$source")
      fi
    done

    if ((${#missing[@]})); then
      "$nix_bin" profile install "${missing[@]}"
    else
      printf '%s\n' 'Nix profile tools already installed; checking for upgrades.'
    fi

    "$nix_bin" profile upgrade --all

# Apply chezmoi-managed dotfiles.
[group('setup')]
apply: (doctor 'apply')
    chezmoi init --source {{ quote(repo_dir) }}
    chezmoi apply --refresh-externals=auto --force

[doc('Bootstrap userland, apply dotfiles, then apply host stages.')]
[group('setup')]
setup: (doctor 'setup') _userland apply _host

# Refresh userland, dotfiles, and host stages on an already-bootstrapped machine.
[group('setup')]
update: _userland apply _host

[private]
_deps:
    install_args=(collection install -r ansible/requirements.yml -p .ansible/collections)
    if [[ ! -f .ansible/collections/ansible_collections/community/general/MANIFEST.json ]]; then
      install_args+=(--force)
    fi
    ansible-galaxy "${install_args[@]}"

[private]
_userland:
    ansible/bootstrap.sh --tags userland

[private]
_host:
    ansible-playbook ansible/site.yml --tags host

# Format the repository through the flake's treefmt wrapper.
[group('dev')]
fmt: (doctor 'fmt') (_format 'write')

# Rerun a recipe when files change.
[arg('args', help='Recipe and arguments to rerun on file changes')]
[group('dev')]
[positional-arguments]
watch +args='check': (doctor 'watch')
    watchexec --clear --restart -- {{ quote(just_executable()) }} --justfile {{ quote(justfile()) }} "$@"

# Run the same treefmt wrapper in CI mode without retaining rewrites.
[group('dev')]
check-format: (doctor 'fmt') (_format 'check')

[private]
_format mode:
    case {{ quote(mode) }} in
      write) nix fmt ;;
      check) nix fmt -- --ci ;;
    esac

[parallel]
[private]
_lint-files: _check-worktree-paths (_run-files 'jq' 'empty' '*.json flake.lock :(exclude).vscode/settings.json') (_run-files 'hadolint' '' 'Dockerfile Containerfile') (_run-files 'luacheck' '--globals Command cx ya --' '*.lua') (_run-files 'rumdl' 'check --respect-gitignore --exclude packages/terminal-theme-tools/vendor/** .' '') _lint-nix (_run-files 'uv' 'run ruff check .' '') _lint-shell-files _lint-shell-templates-portable _lint-templates (_run-files 'taplo' 'lint' '*.toml') _lint-xml

[private]
_check-worktree-paths:
    broken=0
    while IFS= read -r -d '' file; do
      if [[ -L $file && ! -e $file ]]; then
        target=$(readlink "$file")
        if [[ $file == bluebuild/files/system/* && $target == /* && -e bluebuild/files/system$target ]]; then
          continue
        fi
        printf 'broken symlink: %s\n' "$file" >&2
        broken=1
      elif [[ ! -e $file ]]; then
        printf 'tracked path missing from worktree: %s\n' "$file" >&2
      fi
    done < <(git ls-files -z --cached --others --exclude-standard --)
    exit "$broken"

[private]
_lint-nix:
    nix_files=()
    while IFS= read -r -d '' file; do
      [[ -f $file && ! -L $file ]] && nix_files+=("$file")
    done < <(git ls-files -z --cached --others --exclude-standard -- '*.nix')
    deadnix_files=()
    for file in "${nix_files[@]}"; do
      nix-instantiate --parse "$file" >/dev/null
      case $file in
        hosts/linux/hardware-configuration.nix | packages/hyper-window-tiling/bun.nix) ;;
        *) deadnix_files+=("$file") ;;
      esac
    done
    ((${#deadnix_files[@]} == 0)) || deadnix --fail "${deadnix_files[@]}"

[private]
_lint-xml:
    xml_files=()
    while IFS= read -r -d '' file; do
      [[ -f $file && ! -L $file ]] && xml_files+=("$file")
    done < <(git ls-files -z --cached --others --exclude-standard -- '*.plist' '*.xml')
    ((${#xml_files[@]} == 0)) || uv run python -c \
      'import sys; from defusedxml.ElementTree import parse; [parse(path) for path in sys.argv[1:]]' \
      "${xml_files[@]}"

[private]
_lint-templates:
    python_template_files=()
    bash_template_files=()
    zsh_template_files=()
    python_input_template_files=()
    xml_input_template_files=()
    while IFS= read -r -d '' file; do
      [[ -f $file && ! -L $file ]] || continue
      case "$file" in
        dotfiles/.chezmoitemplates/*.py.tmpl) ;;
        dotfiles/dot_bash*.tmpl | *.bash.tmpl | *.sh.tmpl) bash_template_files+=("$file") ;;
        dotfiles/dot_zsh*.tmpl | *.zsh.tmpl) zsh_template_files+=("$file") ;;
        *.py.tmpl) python_template_files+=("$file") ;;
        *.py.in) python_input_template_files+=("$file") ;;
        *.plist.in | *.xml.in) xml_input_template_files+=("$file") ;;
      esac
    done < <(git ls-files -z --cached --others --exclude-standard -- '*.tmpl' '*.py.in' '*.plist.in' '*.xml.in')

    tmp_destination=$(mktemp -d)
    trap 'rm -rf "$tmp_destination"' EXIT
    chezmoi apply \
      --dry-run \
      --source {{ quote(repo_dir) }} \
      --destination "$tmp_destination" \
      --force \
      --no-tty \
      --refresh-externals=never >/dev/null

    for file in \
      "${python_template_files[@]}" \
      "${bash_template_files[@]}" \
      "${zsh_template_files[@]}"; do
      rendered_file="$tmp_destination/rendered-templates/${file%.tmpl}"
      mkdir -p "${rendered_file%/*}"
      chezmoi --source {{ quote(repo_dir) }} execute-template < "$file" > "$rendered_file"
    done
    if ((${#python_template_files[@]} > 0)); then
      PYTHONPYCACHEPREFIX="$tmp_destination/pycache" \
        uv run python -m compileall -q "$tmp_destination/rendered-templates"
      for file in "${python_template_files[@]}"; do
        rendered_file="$tmp_destination/rendered-templates/${file%.tmpl}"
        uv run ruff check --stdin-filename "${file%.tmpl}" - < "$rendered_file"
      done
    fi
    for file in "${bash_template_files[@]}"; do
      rendered_file="$tmp_destination/rendered-templates/${file%.tmpl}"
      bash -n "$rendered_file"
      # Cached integrations are generated by their upstream tools. Syntax-check
      # them, but reserve ShellCheck policy for shell code maintained here.
      case "$file" in
        dotfiles/dot_cache/*) continue ;;
      esac
      shellcheck -x --shell=bash "$rendered_file"
    done
    for file in "${zsh_template_files[@]}"; do
      zsh -n "$tmp_destination/rendered-templates/${file%.tmpl}"
    done
    for file in "${python_input_template_files[@]}"; do
      rendered_file="$tmp_destination/rendered-input-templates/${file%.in}"
      mkdir -p "${rendered_file%/*}"
      sed -E 's/@[A-Za-z_][A-Za-z0-9_]*@/template_value/g' "$file" > "$rendered_file"
    done
    if ((${#python_input_template_files[@]} > 0)); then
      PYTHONPYCACHEPREFIX="$tmp_destination/pycache" \
        uv run python -m compileall -q "$tmp_destination/rendered-input-templates"
    fi
    rendered_xml_files=()
    for file in "${xml_input_template_files[@]}"; do
      rendered_file="$tmp_destination/rendered-input-templates/${file%.in}"
      mkdir -p "${rendered_file%/*}"
      sed -E 's/@[A-Za-z_][A-Za-z0-9_]*@/template_value/g' "$file" > "$rendered_file"
      rendered_xml_files+=("$rendered_file")
    done
    ((${#rendered_xml_files[@]} == 0)) || uv run python -c \
      'import sys; from defusedxml.ElementTree import parse; [parse(path) for path in sys.argv[1:]]' \
      "${rendered_xml_files[@]}"

[private]
_lint-shell-templates-portable:
    platform_overrides=(
      '{"chezmoi":{"os":"darwin","arch":"arm64","osRelease":{}}}'
      '{"chezmoi":{"os":"linux","arch":"amd64","osRelease":{"id":"fedora"}}}'
      '{"chezmoi":{"os":"linux","arch":"amd64","osRelease":{"id":"nixos"}}}'
    )
    shell_template_files=()
    while IFS= read -r -d '' file; do
      [[ -f $file && ! -L $file ]] && shell_template_files+=("$file")
    done < <(
      git ls-files -z --cached --others --exclude-standard -- \
        'dotfiles/dot_bash*.tmpl' \
        'dotfiles/dot_zsh*.tmpl' \
        'dotfiles/dot_config/shell/*.tmpl' \
        'dotfiles/dot_config/shell/exact_bashrc.d/*.tmpl' \
        'dotfiles/dot_config/shell/exact_interactive.d/*.tmpl' \
        'dotfiles/dot_config/shell/exact_zshrc.d/*.tmpl'
    )

    tmp_destination=$(mktemp -d)
    trap 'rm -rf "$tmp_destination"' EXIT
    platform_index=0
    for platform_override in "${platform_overrides[@]}"; do
      platform_index=$((platform_index + 1))
      for file in "${shell_template_files[@]}"; do
        rendered_file="$tmp_destination/$platform_index/${file%.tmpl}"
        mkdir -p "${rendered_file%/*}"
        chezmoi --source {{ quote(repo_dir) }} \
          --override-data "$platform_override" \
          execute-template < "$file" > "$rendered_file"
        case "$file" in
          dotfiles/dot_bash*.tmpl | *.bash.tmpl)
            bash -n "$rendered_file"
            shellcheck -x --shell=bash "$rendered_file"
            ;;
          dotfiles/dot_zsh*.tmpl | *.zsh.tmpl)
            zsh -n "$rendered_file"
            ;;
          *.sh.tmpl)
            bash -n "$rendered_file"
            zsh -n "$rendered_file"
            shellcheck -x --shell=bash "$rendered_file"
            ;;
        esac
      done
    done

[private]
_lint-shell-files:
    shell_files=()
    while IFS= read -r -d '' file; do
      [[ -f $file && ! -L $file ]] || continue
      case "$file" in
        *.tmpl | *.txt | *.patch) continue ;;
        *.sh | *.sh.in | *.bash) shell_files+=("$file"); continue ;;
      esac
      if head -n 2 < "$file" | grep -Eq '^#!.*[[:space:]/](sh|bash)([[:space:]]|$)|^# shellcheck shell=(sh|bash)'; then
        shell_files+=("$file")
      fi
    done < <(git ls-files -z --cached --others --exclude-standard --)
    ((${#shell_files[@]} == 0)) && exit
    shellcheck -x "${shell_files[@]}"

[private]
_run-files executable arguments patterns:
    printf '==> %s %s\n' {{ quote(executable) }} {{ quote(arguments) }}
    argument_array=()
    [[ -z {{ quote(arguments) }} ]] || read -r -a argument_array <<< {{ quote(arguments) }}
    if [[ -z {{ quote(patterns) }} ]]; then
      {{ quote(executable) }} "${argument_array[@]}"
      exit
    fi
    pattern_array=()
    read -r -a pattern_array <<< {{ quote(patterns) }}
    files=()
    while IFS= read -r -d '' file; do
      [[ -f $file && ! -L $file ]] && files+=("$file")
    done < <(git ls-files -z --cached --others --exclude-standard -- "${pattern_array[@]}")
    ((${#files[@]} == 0)) || {{ quote(executable) }} "${argument_array[@]}" "${files[@]}"

[private]
_check-python: python-complexity python-dead-code python-dependencies python-typecheck python-test
    uv lock --check
    uv sync --check
    bytecode_dir=$(mktemp -d)
    build_dir=$(mktemp -d)
    trap 'rm -rf "$bytecode_dir" "$build_dir"' EXIT
    PYTHONPYCACHEPREFIX="$bytecode_dir" uv run python -m compileall -q ansible dotfiles packages
    uv build --out-dir "$build_dir" --no-build-logs

# Update every non-frozen npins source.
[group('dev')]
source-update:
    nix shell nixpkgs#npins --command npins update

# Check declared dependencies against first-party imports.
[group('dev')]
python-dependencies:
    uv run deptry .

# Run the Python test suite.
[group('dev')]
[positional-arguments]
python-test *args:
    uv run pytest "$@"

# Type-check the Python source roots configured in pyproject.toml.
[group('dev')]
[positional-arguments]
python-typecheck *args:
    uv run ty check "$@"

# Scan the first-party Python source roots configured in pyproject.toml.
[group('dev')]
python-dead-code:
    uv run vulture

# Reject cognitively complex functions in the configured Python source roots.
[group('dev')]
python-complexity:
    uv run complexipy --plain

[private]
_check-zig: (doctor 'zig')
    zig fmt --check build.zig packages/terminal-theme-tools/build.zig packages/terminal-theme-tools/build_support.zig packages/terminal-theme-tools/src/*.zig
    zig build test
    zig build --release=small

[private]
_check-ansible: (doctor 'ansible') _deps
    ansible-playbook --syntax-check ansible/site.yml
    ansible-lint ansible
    yamllint .

[private]
_check-github-actions:
    actionlint
    zizmor --persona=pedantic .

[private]
_check-bun: (doctor 'bun')
    bun install --frozen-lockfile
    bun install --cwd packages/hyper-window-tiling --frozen-lockfile
    bun run check

# Regenerate bun2nix's dependency expression for the independently packaged
# Hyper Window Tiling extension after its Bun lockfile changes.
[group('dev')]
bun-nix-update:
    nix run .#bun2nix -- \
      --lock-file packages/hyper-window-tiling/bun.lock \
      --copy-prefix packages/hyper-window-tiling \
      --output-file packages/hyper-window-tiling/bun.nix
    nix fmt -- packages/hyper-window-tiling/bun.nix

[private]
_check-lua:
    while IFS= read -r -d '' test_file; do
      main_file=${test_file%/test.lua}/main.lua
      if [[ ! -f $main_file ]]; then
        printf 'missing Lua plugin entry point for %s: %s\n' "$test_file" "$main_file" >&2
        exit 1
      fi
      lua "$test_file" "$main_file"
    done < <(git ls-files -z --cached --others --exclude-standard -- '*.yazi/test.lua')

# Lint repository source files and run project validation.
[group('dev')]
lint: (doctor 'lint') check-format _lint-checks

[parallel]
[private]
_lint-checks: _lint-files _check-python _check-zig _check-ansible _check-github-actions _check-bun _check-lua

# Run the repo validation suite.
[group('dev')]
check: lint
