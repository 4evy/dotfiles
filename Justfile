#!/usr/bin/env -S just --justfile

set default-list
set default-script
set script-interpreter := ['bash', '-euo', 'pipefail']

image_name := env("SPECTRUM_IMAGE_NAME", "spectrum")
local_tag := env("SPECTRUM_LOCAL_TAG", "local")
local_ref := "localhost/" + image_name + ":" + local_tag
remote_ref := env("SPECTRUM_REMOTE_REF", "ghcr.io/4evy/" + image_name + ":latest")
base_image := env("SPECTRUM_BLUEFIN_BASE_IMAGE", "ghcr.io/ublue-os/bluefin-nvidia-open:stable@sha256:1e7a59c83f104652bd06308f0a6439669cb3ea327d4e968695af85c67abea352")
base_image_digest := if base_image =~ '@sha256:[0-9a-f]{64}$' { replace_regex(base_image, '^.*@', '') } else { error('Spectrum base images must end in a sha256 digest') }
base_image_ref := replace_regex(base_image, '@sha256:[0-9a-f]{64}$', '')
base_image_name := env("SPECTRUM_BLUEFIN_BASE_IMAGE_NAME", "bluefin-nvidia-open")
base_image_tag := env("SPECTRUM_BLUEFIN_BASE_IMAGE_TAG", "stable")
compose := env("COMPOSE", "podman-compose")
podman := env("PODMAN", "podman")
determinate_nix_installer_url := "https://install.determinate.systems/nix"
nixos_nix_installer_url := "https://artifacts.nixos.org/nix-installer"

host_os := os()
repo_dir := justfile_directory()
ansible_dir := repo_dir / "ansible"
dotfiles_dir := repo_dir / "dotfiles"
hyper_dir := repo_dir / "packages/hyper-window-tiling"
ansible_playbooks := prepend("ansible/playbooks/", "bootstrap.yml userland.yml host.yml site.yml")

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
doctor_format_commands := "bun git go gofmt jq nixfmt prettier shfmt stylua taplo uv"
doctor_ansible_commands := "ansible-galaxy ansible-lint ansible-playbook ansible-test yamllint"
doctor_lint_commands := "actionlint chezmoi deadnix golangci-lint hadolint luacheck nix-instantiate shellcheck " + doctor_format_commands + " " + doctor_ansible_commands
doctor_all_commands := doctor_lint_commands + " bash curl sudo watchexec"

repo_file_inventory := '''
repo_paths=() missing_paths=() symlink_files=() broken_symlinks=() special_files=()
template_files=() python_template_files=() shell_template_files=() python_input_template_files=() xml_input_template_files=()
unformatted_files=() enumerated_files=() hyper_files=() just_files=() docker_files=()
go_files=() go_mod_files=() json_files=() json_auto_files=() jsonc_files=() yaml_files=() prettier_files=() prettier_parse_files=()
python_files=() shell_files=() toml_files=() xml_files=() lua_files=() nix_files=()

is_shell_file() {
  case "$1" in
    *.tmpl | *.txt | *.patch) return 1 ;;
    *.sh | *.sh.in | *.bash) return 0 ;;
  esac

  head -n 2 < "$1" | grep -Eq '^#!.*[[:space:]/](sh|bash)([[:space:]]|$)|^# shellcheck shell=(sh|bash)'
}

classify_file() {
  local file=$1 base=${1##*/}

  if [[ $file == packages/hyper-window-tiling/* ]]; then
    hyper_files+=("$file")
    return
  fi

  case "$base" in
    Justfile | justfile) just_files+=("$file"); enumerated_files+=("$file"); return ;;
    Dockerfile | Containerfile) docker_files+=("$file"); unformatted_files+=("$file"); return ;;
    go.mod) go_mod_files+=("$file"); return ;;
    flake.lock) json_files+=("$file"); return ;;
    package-lock.json | npm-shrinkwrap.json) json_auto_files+=("$file"); return ;;
    uv.lock) unformatted_files+=("$file"); enumerated_files+=("$file"); return ;;
  esac

  case "$file" in
    .yamllint | .ansible-lint) yaml_files+=("$file"); unformatted_files+=("$file") ;;
    *.plist.in | *.xml.in) xml_input_template_files+=("$file"); unformatted_files+=("$file") ;;
    *.py.in) python_input_template_files+=("$file"); unformatted_files+=("$file") ;;
    *.bash.tmpl | *.sh.tmpl) template_files+=("$file"); shell_template_files+=("$file") ;;
    *.py.tmpl) template_files+=("$file"); python_template_files+=("$file") ;;
    *.tmpl) template_files+=("$file") ;;
    *.jsonc) jsonc_files+=("$file") ;;
    *.json) json_files+=("$file") ;;
    *.yaml | *.yml) yaml_files+=("$file"); prettier_files+=("$file") ;;
    *.md) prettier_files+=("$file"); prettier_parse_files+=("$file") ;;
    *.js | *.cjs | *.mjs | *.jsx | *.ts | *.tsx | *.css | *.html | *.mdx) prettier_files+=("$file"); prettier_parse_files+=("$file") ;;
    *.go) go_files+=("$file") ;;
    *.py) python_files+=("$file") ;;
    *.sh | *.sh.in | *.bash) shell_files+=("$file") ;;
    *.toml) toml_files+=("$file") ;;
    *.plist | *.xml) xml_files+=("$file"); unformatted_files+=("$file") ;;
    *.lua) lua_files+=("$file") ;;
    *.nix) nix_files+=("$file") ;;
    *)
      if is_shell_file "$file"; then
        shell_files+=("$file")
      else
        unformatted_files+=("$file")
        enumerated_files+=("$file")
      fi
      ;;
  esac
}

while IFS= read -r -d '' file; do
  repo_paths+=("$file")
  if [[ -L $file ]]; then
    symlink_files+=("$file")
    [[ -e $file ]] || broken_symlinks+=("$file")
  elif [[ ! -e $file ]]; then
    missing_paths+=("$file")
  elif [[ -f $file ]]; then
    classify_file "$file"
  else
    special_files+=("$file")
    enumerated_files+=("$file")
  fi
done < <(git ls-files -z --cached --others --exclude-standard --)

if ((${#missing_paths[@]} > 0)); then
  printf 'tracked paths missing from worktree:\n' >&2
  printf '  %s\n' "${missing_paths[@]}" >&2
fi
'''

export PATH := homebrew_path + PATH_VAR_SEP + nix_bin_dir + PATH_VAR_SEP + nix_profile_bin_dir + PATH_VAR_SEP + nixos_profile_bin_dir + PATH_VAR_SEP + env("PATH", "")

alias a := apply
alias b := build
alias c := check
alias cf := check-format
alias ck := check
alias f := fmt
alias i := install
alias l := lint
alias nx := nix
alias r := reboot
alias s := setup
alias sw := switch
alias u := upgrade
alias up := update
alias w := watch

# Check commands required for a workflow profile.
[arg('profile', pattern='status|reboot|install|build|setup|apply|shell|spectrum|fmt|lint|go|ansible|bun|smoke|nix|watch|check|all', help='status, reboot, install, build, setup, apply, shell, spectrum, fmt, lint, go, ansible, bun, smoke, nix, watch, check, or all')]
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
      build) commands=("${podman_command%% *}" sudo) ;;
      setup) commands=({{ doctor_setup_commands }}) ;;
      apply) commands=(chezmoi) ;;
      shell) commands=(shellcheck shfmt) ;;
      spectrum) commands=(uv) ;;
      fmt) commands=({{ doctor_format_commands }}) ;;
      lint | check) commands=({{ doctor_lint_commands }}) ;;
      go) commands=(go golangci-lint) ;;
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

# Build the local Spectrum bootc image, reusing cached layers.
[arg('target', help='Image reference to tag locally')]
[group('spectrum')]
[linux]
build target=local_ref: (_build target 'false')

[arg('target', help='Image reference to tag locally')]
[group('spectrum')]
[macos]
build target=local_ref: (_linux-only recipe_name())

# Rebuild the local Spectrum bootc image without using cached layers.
[arg('target', help='Image reference to tag locally')]
[group('spectrum')]
[linux]
build-clean target=local_ref: (_build target 'true')

[arg('target', help='Image reference to tag locally')]
[group('spectrum')]
[macos]
build-clean target=local_ref: (_linux-only recipe_name())

[arg('no_cache', pattern='true|false')]
[linux]
[private]
_build target no_cache: (doctor 'build')
    target={{ quote(target) }}
    no_cache={{ quote(no_cache) }}
    base_image={{ quote(base_image) }}
    base_image_name={{ quote(base_image_name) }}
    base_image_tag={{ quote(base_image_tag) }}
    image_name={{ quote(image_name) }}
    local_tag={{ quote(local_tag) }}
    read -r -a podman_command <<< {{ quote(podman) }}
    image_created={{ quote(datetime_utc("%Y-%m-%dT%H:%M:%SZ")) }}
    image_revision=$(git rev-parse HEAD 2>/dev/null || printf '%s' unknown)
    image_version=$(git describe --tags --always --dirty 2>/dev/null || printf '%s' "$local_tag")
    base_image_ref={{ quote(base_image_ref) }}
    base_image_digest={{ quote(base_image_digest) }}

    build_args=(
      --layers=true \
      --pull=newer \
      --tag "$target" \
      --build-arg "BLUEFIN_BASE_IMAGE=$base_image" \
      --build-arg "BLUEFIN_BASE_IMAGE_NAME=$base_image_name" \
      --build-arg "BLUEFIN_BASE_IMAGE_TAG=$base_image_tag" \
      --build-arg "IMAGE_NAME=$image_name" \
      --build-arg "IMAGE_TAG=$local_tag" \
      --build-arg "IMAGE_REF=ostree-image:docker://$target" \
      --build-arg "IMAGE_REVISION=$image_revision" \
      --build-arg "IMAGE_VERSION=$image_version" \
      --label "org.opencontainers.image.created=$image_created" \
      --label "org.opencontainers.image.base.name=$base_image_ref" \
      --label "org.opencontainers.image.base.digest=$base_image_digest" \
      --file spectrum/Containerfile
    )

    if [[ "$image_revision" != unknown ]]; then
      repository_url=https://github.com/4evy/dotfiles
      raw_repository_url=https://raw.githubusercontent.com/4evy/dotfiles
      build_args+=(
        --build-arg "IMAGE_SOURCE=$repository_url/blob/$image_revision/spectrum/Containerfile"
        --build-arg "IMAGE_URL=$repository_url/tree/$image_revision"
        --build-arg "IMAGE_DOCUMENTATION=$raw_repository_url/$image_revision/README.md"
        --build-arg "IMAGE_README=$raw_repository_url/$image_revision/README.md"
      )
    fi

    if [[ $no_cache == true ]]; then
      build_args+=(--no-cache)
    fi

    github_token_file=
    sudo_keepalive_pid=
    cleanup() {
      if [[ -n "$sudo_keepalive_pid" ]]; then
        kill "$sudo_keepalive_pid" 2>/dev/null || true
        wait "$sudo_keepalive_pid" 2>/dev/null || true
      fi
      if [[ -n "$github_token_file" ]]; then
        rm -f "$github_token_file"
      fi
    }
    trap cleanup EXIT

    if [[ -n "${GITHUB_TOKEN:-}" || -n "${GH_TOKEN:-}" ]]; then
      github_token_file=$(mktemp)
      printf '%s' "${GITHUB_TOKEN:-$GH_TOKEN}" >"$github_token_file"
      chmod 600 "$github_token_file"
      build_args+=(--secret "id=github_token,src=$github_token_file")
    fi

    # A Spectrum build can outlast sudo's credential timeout. Keep this
    # terminal's timestamp fresh so a dependent switch/upgrade stays
    # unattended after the single up-front authentication.
    sudo -v
    (
      while sleep 60; do
        sudo -n -v || exit
      done
    ) &
    sudo_keepalive_pid=$!

    sudo -n env \
      -u XDG_RUNTIME_DIR \
      -u DBUS_SESSION_BUS_ADDRESS \
      -u WAYLAND_DISPLAY \
      -u DISPLAY \
      -u SSH_AUTH_SOCK \
      "${podman_command[@]}" build "${build_args[@]}" .

    sudo -n -v || {
      printf '%s\n' 'sudo credential keepalive expired during the Spectrum build' >&2
      exit 1
    }

# Compatibility name for the cached local Spectrum build.
[arg('target', help='Image reference to tag locally')]
[group('spectrum')]
[linux]
spectrum-dev target=local_ref: (build target)

[arg('target', help='Image reference to tag locally')]
[group('spectrum')]
[macos]
spectrum-dev target=local_ref: (_linux-only recipe_name())

# Validate Spectrum build scripts without building the image.
[group('spectrum')]
spectrum-lint: _check-spectrum

# Report boot and kernel artifact sizes from a built Spectrum image.
[arg('target', help='Built image reference to inspect')]
[group('spectrum')]
[linux]
spectrum-boot-report target=local_ref: (doctor 'build')
    target={{ quote(target) }}
    read -r -a podman_command <<< {{ quote(podman) }}
    sudo "${podman_command[@]}" run \
      --rm \
      --entrypoint bash \
      --volume {{ quote(repo_dir + ":/workspace:ro") }} \
      "$target" \
      -ceu '
        mkdir -p /tmp/spectrum-workspace/ansible/files/scripts
        mkdir -p /tmp/spectrum-workspace/spectrum
        cp /workspace/pyproject.toml /workspace/uv.lock /tmp/spectrum-workspace/
        cp -a /workspace/ansible/files/scripts/workstation \
          /tmp/spectrum-workspace/ansible/files/scripts/
        cp -a /workspace/spectrum/scripts /tmp/spectrum-workspace/spectrum/
        UV_PROJECT_ENVIRONMENT=/tmp/spectrum-boot-report-venv \
          uv --cache-dir /tmp/spectrum-uv-cache \
            --directory /tmp/spectrum-workspace \
            run --locked python /tmp/spectrum-workspace/spectrum/scripts/boot_artifacts.py
      '

# Show RPM package differences between the selected Bluefin base and Spectrum.
[arg('base', help='Bluefin base image reference to compare against')]
[arg('target', help='Built Spectrum image reference to inspect')]
[group('spectrum')]
[linux]
spectrum-diff target=local_ref base=base_image: (doctor 'build')
    target={{ quote(target) }}
    base={{ quote(base) }}
    read -r -a podman_command <<< {{ quote(podman) }}
    work_dir=$(mktemp -d)
    trap 'rm -rf "$work_dir"' EXIT

    sudo "${podman_command[@]}" run --rm --entrypoint rpm "$base" \
      -qa --qf '%{NAME}\n' | sort -u >"$work_dir/base"
    sudo "${podman_command[@]}" run --rm --entrypoint rpm "$target" \
      -qa --qf '%{NAME}\n' | sort -u >"$work_dir/target"

    printf '%s\n' 'Only in Spectrum:'
    comm -13 "$work_dir/base" "$work_dir/target" || true
    printf '\n%s\n' 'Only in base image:'
    comm -23 "$work_dir/base" "$work_dir/target" || true

# Switch the host to the published Spectrum image on next boot.
[arg('target', help='Published bootc image reference')]
[confirm('Switch this host to published Spectrum image ' + target + '?')]
[group('spectrum')]
[linux]
[shell]
install target=remote_ref: (doctor 'install')
    sudo bootc switch {{ quote(target) }}
    @printf '%s\n' 'Run `just reboot`, then `just setup` after reboot.'

[arg('target', help='Published bootc image reference')]
[group('spectrum')]
[macos]
install target=remote_ref: (_linux-only recipe_name())

# Rebuild and switch the host to the local Spectrum image on next boot.
[arg('target', help='Local containers-storage image reference')]
[confirm('Switch this host to local Spectrum image ' + target + '?')]
[group('spectrum')]
[linux]
switch target=local_ref: (doctor 'install') (build target)
    target={{ quote(target) }}
    switch_log=$(mktemp)
    trap 'rm -f "$switch_log"' EXIT

    if sudo -n bootc switch --transport containers-storage "$target" \
      > >(tee "$switch_log") \
      2> >(tee -a "$switch_log" >&2); then
      switch_status=0
    else
      switch_status=$?
    fi

    if grep -Fxq 'Image specification is unchanged.' "$switch_log"; then
      printf 'Already tracking %s; staging the latest local image with `bootc upgrade`.\n' "$target"
      sudo -n bootc upgrade
      exit 0
    fi

    exit "$switch_status"

[arg('target', help='Local containers-storage image reference')]
[group('spectrum')]
[macos]
switch target=local_ref: (_linux-only recipe_name())

# Rebuild the local Spectrum image and stage it as an upgrade.
[arg('target', help='Local image reference to rebuild before upgrade')]
[confirm('Rebuild ' + target + ' and stage it as a bootc upgrade?')]
[group('spectrum')]
[linux]
upgrade target=local_ref: (doctor 'install') (build target)
    sudo -n bootc upgrade

[arg('target', help='Local image reference to rebuild before upgrade')]
[group('spectrum')]
[macos]
upgrade target=local_ref: (_linux-only recipe_name())

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

# Install Nix on macOS without modifying the user's shell profile.
[macos]
[private]
_ensure-nix:
    command -v nix >/dev/null 2>&1 ||
      curl -fsSL {{ quote(nixos_nix_installer_url) }} |
        sh -s -- install macos --enable-flakes --no-confirm --no-modify-profile

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
      printf '%s\n' 'Nix profile tools already installed.'
    fi

# Apply chezmoi-managed dotfiles.
[group('setup')]
apply: (doctor 'apply')
    chezmoi init --source {{ quote(dotfiles_dir) }}
    chezmoi apply --refresh-externals=auto --force

[doc('Bootstrap userland, apply dotfiles, then apply host roles.')]
[group('setup')]
setup: (doctor 'setup') _userland apply _host

# Refresh userland, dotfiles, and host roles on an already-bootstrapped machine.
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
    {{ quote(ansible_dir / "bootstrap.sh") }} ansible/playbooks/userland.yml

[private]
_host:
    ansible-playbook ansible/playbooks/host.yml

# Format files managed by this repo.
[group('dev')]
[parallel]
fmt: (_format-files 'write') (_hyper-format 'write')

# Rerun a recipe when files change.
[arg('args', help='Recipe and arguments to rerun on file changes')]
[group('dev')]
[positional-arguments]
watch +args='check': (doctor 'watch')
    watchexec --clear --restart -- {{ quote(just_executable()) }} --justfile {{ quote(justfile()) }} "$@"

# Check repository formatting without rewriting files.
[group('dev')]
[parallel]
check-format: (_format-files 'check') (_hyper-format 'check')

[arg('mode', pattern='write|check')]
[private]
_format-files mode: (doctor 'fmt')
    mode={{ quote(mode) }}

    {{ repo_file_inventory }}

    formatted_count=$((${#hyper_files[@]} + ${#go_files[@]} + ${#go_mod_files[@]} + ${#json_files[@]} + ${#json_auto_files[@]} + ${#jsonc_files[@]} + ${#prettier_files[@]} + ${#python_files[@]} + ${#shell_files[@]} + ${#toml_files[@]} + ${#lua_files[@]} + ${#nix_files[@]} + ${#just_files[@]}))
    accounted_count=$((formatted_count + ${#template_files[@]} + ${#unformatted_files[@]} + ${#symlink_files[@]} + ${#missing_paths[@]} + ${#special_files[@]}))
    if ((accounted_count != ${#repo_paths[@]})); then
      printf 'internal error: classified %d of %d repository paths\n' "$accounted_count" "${#repo_paths[@]}" >&2
      exit 1
    fi

    printf 'repo paths: %d; formatting check/write covers %d content files; templates enumerated: %d; no structured formatter: %d; symlinks: %d; special: %d; missing/deleted: %d\n' \
      "${#repo_paths[@]}" \
      "$formatted_count" \
      "${#template_files[@]}" \
      "${#unformatted_files[@]}" \
      "${#symlink_files[@]}" \
      "${#special_files[@]}" \
      "${#missing_paths[@]}"

    check_gofmt() {
      local gofmt_output
      if ! gofmt_output=$(gofmt -l "$@"); then
        printf '%s\n' 'gofmt failed' >&2
        exit 1
      fi
      if [[ -n "$gofmt_output" ]]; then
        printf '%s\n' "$gofmt_output"
        printf '%s\n' 'Go files need gofmt' >&2
        exit 1
      fi
    }

    check_go_mod_fmt() {
      local file formatted
      for file in "$@"; do
        formatted=$(go mod edit -fmt -print "$file")
        if ! cmp -s "$file" <(printf '%s\n' "$formatted"); then
          printf '%s\n' "$file"
          printf '%s\n' 'go.mod files need go mod edit -fmt' >&2
          exit 1
        fi
      done
    }

    ((${#json_files[@]} + ${#json_auto_files[@]} == 0)) || jq empty "${json_files[@]}" "${json_auto_files[@]}"

    if [[ "$mode" == write ]]; then
      ((${#just_files[@]} == 0)) || {{ quote(just_executable()) }} --fmt -f {{ quote(justfile()) }}
      ((${#go_files[@]} == 0)) || gofmt -w "${go_files[@]}"
      for file in "${go_mod_files[@]}"; do
        go mod edit -fmt "$file"
      done
      ((${#python_files[@]} == 0)) || uv run --locked ruff format --force-exclude "${python_files[@]}"
      ((${#json_files[@]} == 0)) || prettier --write --parser json "${json_files[@]}"
      ((${#json_auto_files[@]} == 0)) || prettier --write "${json_auto_files[@]}"
      ((${#jsonc_files[@]} == 0)) || prettier --write --parser jsonc --trailing-comma none "${jsonc_files[@]}"
      ((${#prettier_files[@]} == 0)) || prettier --write "${prettier_files[@]}"
      ((${#shell_files[@]} == 0)) || shfmt -ci -w "${shell_files[@]}"
      ((${#toml_files[@]} == 0)) || taplo fmt "${toml_files[@]}"
      ((${#lua_files[@]} == 0)) || stylua "${lua_files[@]}"
      ((${#nix_files[@]} == 0)) || nixfmt "${nix_files[@]}"
    else
      ((${#just_files[@]} == 0)) || {{ quote(just_executable()) }} --fmt --check -f {{ quote(justfile()) }}
      ((${#go_files[@]} == 0)) || check_gofmt "${go_files[@]}"
      ((${#go_mod_files[@]} == 0)) || check_go_mod_fmt "${go_mod_files[@]}"
      ((${#python_files[@]} == 0)) || uv run --locked ruff format --check --force-exclude "${python_files[@]}"
      ((${#json_files[@]} == 0)) || prettier --check --parser json "${json_files[@]}"
      ((${#json_auto_files[@]} == 0)) || prettier --check "${json_auto_files[@]}"
      ((${#jsonc_files[@]} == 0)) || prettier --check --parser jsonc --trailing-comma none "${jsonc_files[@]}"
      ((${#prettier_files[@]} == 0)) || prettier --check "${prettier_files[@]}"
      ((${#shell_files[@]} == 0)) || shfmt -ci -d "${shell_files[@]}"
      ((${#toml_files[@]} == 0)) || taplo fmt --check "${toml_files[@]}"
      ((${#lua_files[@]} == 0)) || stylua --check "${lua_files[@]}"
      ((${#nix_files[@]} == 0)) || nixfmt --check "${nix_files[@]}"
    fi

[arg('mode', pattern='write|check')]
[private]
[working-directory(hyper_dir)]
_hyper-format mode: (doctor 'bun')
    {{ if mode == "write" { "bun run format" } else { "bun run biome format ." } }}

[private]
_lint-files: (doctor 'lint')
    {{ repo_file_inventory }}

    linted_count=$((${#hyper_files[@]} + ${#docker_files[@]} + ${#go_files[@]} + ${#go_mod_files[@]} + ${#json_files[@]} + ${#json_auto_files[@]} + ${#jsonc_files[@]} + ${#yaml_files[@]} + ${#toml_files[@]} + ${#xml_files[@]} + ${#python_files[@]} + ${#shell_files[@]} + ${#nix_files[@]} + ${#lua_files[@]} + ${#prettier_parse_files[@]}))
    accounted_count=$((linted_count + ${#template_files[@]} + ${#python_input_template_files[@]} + ${#xml_input_template_files[@]} + ${#enumerated_files[@]} + ${#symlink_files[@]} + ${#missing_paths[@]}))
    if ((accounted_count != ${#repo_paths[@]})); then
      printf 'internal error: classified %d of %d repository paths\n' "$accounted_count" "${#repo_paths[@]}" >&2
      exit 1
    fi

    printf 'repo paths: %d; linted/parsed content files: %d; chezmoi templates: %d (python syntax: %d; shell syntax: %d); generated syntax: %d python, %d XML; enumerated-only files: %d; symlinks: %d; missing/deleted: %d; broken symlinks: %d\n' \
      "${#repo_paths[@]}" \
      "$linted_count" \
      "${#template_files[@]}" \
      "${#python_template_files[@]}" \
      "${#shell_template_files[@]}" \
      "${#python_input_template_files[@]}" \
      "${#xml_input_template_files[@]}" \
      "${#enumerated_files[@]}" \
      "${#symlink_files[@]}" \
      "${#missing_paths[@]}" \
      "${#broken_symlinks[@]}"

    if ((${#broken_symlinks[@]} > 0)); then
      printf 'broken symlinks:\n' >&2
      printf '  %s\n' "${broken_symlinks[@]}" >&2
      exit 1
    fi

    check_xml() {
      uv run --locked python - "$@" <<'PY'
    from __future__ import annotations

    import sys

    from defusedxml.ElementTree import parse

    for path in sys.argv[1:]:
        try:
            parse(path)
        except Exception as error:
            raise SystemExit(f"{path}: {error}") from error
    PY
    }

    ((${#yaml_files[@]} == 0)) || yamllint "${yaml_files[@]}"
    ((${#docker_files[@]} == 0)) || hadolint "${docker_files[@]}"
    ((${#toml_files[@]} == 0)) || taplo lint "${toml_files[@]}"
    ((${#xml_files[@]} == 0)) || check_xml "${xml_files[@]}"
    ((${#python_files[@]} == 0)) || uv run --locked ruff check --force-exclude "${python_files[@]}"
    ((${#shell_files[@]} == 0)) || shellcheck -x "${shell_files[@]}"
    if ((${#nix_files[@]} > 0)); then
      for file in "${nix_files[@]}"; do
        nix-instantiate --parse "$file" >/dev/null
      done
      deadnix_files=()
      for file in "${nix_files[@]}"; do
        [[ "$file" == hosts/linux/hardware-configuration.nix ]] || deadnix_files+=("$file")
      done
      ((${#deadnix_files[@]} == 0)) || deadnix --fail "${deadnix_files[@]}"
    fi
    ((${#lua_files[@]} == 0)) || luacheck --globals Command cx ya -- "${lua_files[@]}"

    if ((${#template_files[@]} > 0 || ${#python_input_template_files[@]} > 0 || ${#xml_input_template_files[@]} > 0)); then
      tmp_destination=$(mktemp -d)
      trap 'rm -rf "$tmp_destination"' EXIT
      if ((${#template_files[@]} > 0)); then
        chezmoi apply \
          --dry-run \
          --source {{ quote(dotfiles_dir) }} \
          --destination "$tmp_destination" \
          --force \
          --no-tty \
          --refresh-externals=never >/dev/null
      fi

      for file in "${python_template_files[@]}" "${shell_template_files[@]}"; do
        rendered_file="$tmp_destination/rendered-templates/${file%.tmpl}"
        mkdir -p "${rendered_file%/*}"
        chezmoi --source {{ quote(dotfiles_dir) }} execute-template < "$file" > "$rendered_file"
      done
      if ((${#python_template_files[@]} > 0)); then
        PYTHONPYCACHEPREFIX="$tmp_destination/pycache" \
          uv run --locked python -m compileall -q "$tmp_destination/rendered-templates"
        for file in "${python_template_files[@]}"; do
          rendered_file="$tmp_destination/rendered-templates/${file%.tmpl}"
          uv run --locked ruff check --stdin-filename "${file%.tmpl}" - < "$rendered_file"
        done
      fi
      for file in "${shell_template_files[@]}"; do
        rendered_file="$tmp_destination/rendered-templates/${file%.tmpl}"
        bash -n "$rendered_file"
      done
      for file in "${python_input_template_files[@]}"; do
        rendered_file="$tmp_destination/rendered-input-templates/${file%.in}"
        mkdir -p "${rendered_file%/*}"
        sed -E 's/@[A-Za-z_][A-Za-z0-9_]*@/template_value/g' "$file" > "$rendered_file"
      done
      if ((${#python_input_template_files[@]} > 0)); then
        PYTHONPYCACHEPREFIX="$tmp_destination/pycache" \
          uv run --locked python -m compileall -q "$tmp_destination/rendered-input-templates"
      fi
      rendered_xml_files=()
      for file in "${xml_input_template_files[@]}"; do
        rendered_file="$tmp_destination/rendered-input-templates/${file%.in}"
        mkdir -p "${rendered_file%/*}"
        sed -E 's/@[A-Za-z_][A-Za-z0-9_]*@/template_value/g' "$file" > "$rendered_file"
        rendered_xml_files+=("$rendered_file")
      done
      ((${#rendered_xml_files[@]} == 0)) || check_xml "${rendered_xml_files[@]}"
    fi

[private]
_check-spectrum-build: (doctor 'spectrum')
    uv run --locked spectrum-build check

[private]
_check-spectrum: (doctor 'spectrum') _check-spectrum-build
    bytecode_dir=$(mktemp -d)
    trap 'rm -rf "$bytecode_dir"' EXIT
    uv run --locked ty check spectrum/scripts/build.py spectrum/scripts/boot_artifacts.py spectrum/scripts/spectrum_build
    PYTHONPYCACHEPREFIX="$bytecode_dir" uv run --locked python -m compileall -q spectrum/scripts

[private]
_check-python: python-complexity python-dead-code
    uv lock --check
    uv sync --locked --check
    uv run --locked deptry .
    uv run --locked ty check
    bytecode_dir=$(mktemp -d)
    build_dir=$(mktemp -d)
    trap 'rm -rf "$bytecode_dir" "$build_dir"' EXIT
    PYTHONPYCACHEPREFIX="$bytecode_dir" uv run --locked python -m compileall -q ansible/files/scripts dotfiles/.chezmoiscripts internal/chromiumbrowser/scripts packages/toshy spectrum/scripts
    uv run --locked pytest
    uv build --out-dir "$build_dir" --no-build-logs

# Scan every tracked or untracked, non-ignored Python source file for dead code.
[group('dev')]
python-dead-code: (_python-analysis 'vulture')

# Reject cognitively complex functions in every first-party Python source file.
[group('dev')]
python-complexity: (_python-analysis 'complexipy')

[arg('tool', pattern='vulture|complexipy')]
[private]
_python-analysis tool:
    python_files=()
    while IFS= read -r -d '' file; do
      [[ -f $file ]] && python_files+=("$file")
    done < <(git ls-files -z --cached --others --exclude-standard -- '*.py')
    ((${#python_files[@]} == 0)) || {{ if tool == "complexipy" { "uv run --locked complexipy --failed --plain" } else { "uv run --locked vulture" } }} "${python_files[@]}"

[private]
_check-go: (doctor 'go')
    go test ./...
    golangci-lint run ./...

[private]
_check-ansible: (doctor 'ansible') _deps _check-ansible-collection
    for playbook in {{ ansible_playbooks }}; do
      ansible-playbook --syntax-check "$playbook"
    done
    ansible-lint ansible
    yamllint .

[private]
[working-directory('ansible/collections/ansible_collections/evy/dotfiles')]
_check-ansible-collection:
    ansible-test sanity --local --skip-test validate-modules
    ansible-test integration --local operation

[private]
_check-github-actions:
    actionlint

[private]
_check-bun: (doctor 'bun')
    bun install --frozen-lockfile --filter hyper-window-tiling
    bun run --filter hyper-window-tiling check

# Lint repository source files and run project validation.
[group('dev')]
lint: (doctor 'lint') check-format _lint-checks

[parallel]
[private]
_lint-checks: _lint-files _check-python _check-spectrum-build _check-go _check-ansible _check-github-actions _check-bun

# Run the repo validation suite.
[group('dev')]
check: lint
