#!/usr/bin/env bash
# shellcheck shell=bash
#
# Prepare a fresh macOS or Linux host and run this repository's Ansible
# playbook using system-provided command-line tools.
# Resolve Bash through PATH for NixOS, which has no /bin/bash. Staying
# compatible with macOS's Bash 3.2 avoids requiring a newer interpreter
# before the bootstrap dependencies are installed.

set -euo pipefail

readonly ANSIBLE_PLAYBOOK='ansible/site.yml'
readonly ANSIBLE_REQUIREMENTS_FILE='ansible/requirements.yml'
readonly ANSIBLE_COLLECTIONS_DIRECTORY='.ansible/collections'
readonly PRIVATE_SETTINGS_FILE='secrets/secrets.yaml'
readonly MACOS_AGE_KEY_HELPER_FILE='dotfiles/dot_local/bin/executable_sops-age-key-1password'
readonly MINIMUM_MACOS_MAJOR='27'
readonly PYTHON_VERSION='3.14'
readonly DOWNLOAD_ATTEMPTS='3'
readonly SUDO_PASSWORD_ATTEMPTS='3'
readonly PYTHON_COMMAND="python${PYTHON_VERSION}"
readonly USER_EXECUTABLE_DIRECTORY="${HOME}/.local/bin"
# Update the revision and checksum together from Homebrew/install's install.sh.
readonly HOMEBREW_INSTALLER_REVISION='525cea89e317348cda72711932734eb30613b559'
readonly DEFAULT_HOMEBREW_INSTALLER_URL="https://raw.githubusercontent.com/Homebrew/install/${HOMEBREW_INSTALLER_REVISION}/install.sh"
readonly DEFAULT_HOMEBREW_INSTALLER_CHECKSUM='71d25d14c32edd7adeaf4413ba671b28474ea08e4f6662cb1a73e85ff0eba368'
# These environment overrides are intentional hatches for mirrors and the
# simulator. Overriding only the URL remains safe because the pinned checksum
# will reject different content; alternate content must supply both values.
readonly HOMEBREW_INSTALLER_URL="${HOMEBREW_INSTALLER_URL:-${DEFAULT_HOMEBREW_INSTALLER_URL}}"
readonly HOMEBREW_INSTALLER_CHECKSUM="${HOMEBREW_INSTALLER_CHECKSUM:-${DEFAULT_HOMEBREW_INSTALLER_CHECKSUM}}"

readonly -a HOMEBREW_FORMULAE=(
	'ruby'
	'sops'
	'uv'
)

readonly -a MACOS_HOMEBREW_CASKS=(
	'1password'
	'1password-cli'
)

readonly -a MACOS_GNU_PATH_SUFFIXES=(
	'opt/coreutils/libexec/gnubin'
	'opt/findutils/libexec/gnubin'
	'opt/gnu-sed/libexec/gnubin'
	'opt/grep/libexec/gnubin'
	'opt/gawk/libexec/gnubin'
	'opt/gnu-tar/libexec/gnubin'
	'opt/gnu-which/libexec/gnubin'
	'opt/diffutils/libexec/gnubin'
	'opt/make/libexec/gnubin'
	'opt/gnu-getopt/bin'
)

readonly -a PYTHON_ALIASES=(
	'python'
	'python3'
)

readonly -a REQUIRED_ANSIBLE_COMMANDS=(
	'ansible-galaxy'
	'ansible-lint'
	'ansible-playbook'
)

readonly -a REQUIRED_ANSIBLE_COLLECTIONS=(
	'community/general'
	'community/sops'
)

readonly -a REQUIRED_REPOSITORY_FILES=(
	"${ANSIBLE_PLAYBOOK}"
	"${ANSIBLE_REQUIREMENTS_FILE}"
	"${PRIVATE_SETTINGS_FILE}"
	"${MACOS_AGE_KEY_HELPER_FILE}"
	'Justfile'
	'pyproject.toml'
	'uv.lock'
	'packages/records/cmd/files.go'
	'packages/records/cmd/main.go'
	'packages/records/cmd/source.go'
	'packages/records/cmd/vault.go'
	'packages/records/cmd/workspace.go'
	'packages/records/go.mod'
	'packages/records/go.sum'
	'secrets/records.yaml'
)

UV_PYTHON_BIN_DIR="${USER_EXECUTABLE_DIRECTORY}"
UV_TOOL_BIN_DIR="${USER_EXECUTABLE_DIRECTORY}"
readonly UV_PYTHON_BIN_DIR UV_TOOL_BIN_DIR
export UV_PYTHON_BIN_DIR UV_TOOL_BIN_DIR

# Mutable state is limited to the private directory tracked by exit traps.
temporary_directory=''
temporary_directory_parent=''
inferred_ansible_become_pass=''

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

warn() {
	printf 'warning: %s\n' "$*" >&2
}

log() {
	printf '\n==> %s\n' "$*"
}

command_exists() {
	command -v "$1" >/dev/null 2>&1
}

usage() {
	cat <<'EOF'
Usage:
  ansible/bootstrap.sh --setup
  ansible/bootstrap.sh [ANSIBLE-PLAYBOOK-ARG ...]

Options:
  --setup  Install userland, apply chezmoi dotfiles, and configure the host.
  -h, --help
           Show this help.

Without --setup, all arguments are forwarded to ansible-playbook after the
bootstrap dependencies and Ansible collections are installed.
On NixOS, use the active system tools and reconcile only collections, home
files, and host integrations; rebuild NixOS separately to update programs.
EOF
}

validate_required_values() {
	local value_description="$1"
	shift
	local value

	if (($# == 0)); then
		die "bootstrap configuration has no ${value_description}"
	fi
	for value in "$@"; do
		if [[ -z "${value}" ]]; then
			die "bootstrap configuration contains an empty ${value_description}"
		fi
	done
}

# Validate required package, command, and repository file lists.
validate_configuration() {
	validate_required_values 'Homebrew formula' "${HOMEBREW_FORMULAE[@]}"
	validate_required_values \
		'required Ansible command' "${REQUIRED_ANSIBLE_COMMANDS[@]}"
	validate_required_values \
		'required Ansible collection' "${REQUIRED_ANSIBLE_COLLECTIONS[@]}"
	validate_required_values \
		'required repository file' "${REQUIRED_REPOSITORY_FILES[@]}"
}

has_ansible_become_prompt_arg() {
	local arg

	for arg in "$@"; do
		case "${arg}" in
			--ask-become-pass | -K | --become-password-file | \
				--become-password-file=* | --become-pass-file | \
				--become-pass-file=*)
				return 0
				;;
		esac
	done

	return 1
}

needs_ansible_become_prompt() {
	# Respect every explicit Ansible credential choice, including the string
	# "false". The bootstrap may infer a prompt only when the caller is silent.
	[[ -t 0 ]] || return 1
	[[ -z "${ANSIBLE_BECOME_PASSWORD:-}" ]] || return 1
	[[ -z "${ANSIBLE_BECOME_PASS:-}" ]] || return 1
	[[ -z "${ANSIBLE_BECOME_ASK_PASS:-}" ]] || return 1
	has_ansible_become_prompt_arg "$@" && return 1

	# Ignore cached credentials here: their scope can differ from the sudo
	# process Ansible starts. Only skip a password when sudo is genuinely
	# configured to work without one.
	if command_exists sudo && sudo -n -k -v >/dev/null 2>&1; then
		return 1
	fi

	return 0
}

# Read and validate the password before Ansible starts. Ansible aborts when a
# rejected password makes sudo emit a second prompt, so retries must happen
# here instead. The password remains only in this shell's memory.
# Globals:
#   inferred_ansible_become_pass
capture_ansible_become_password() {
	local attempt
	local current_user

	if ! command_exists sudo; then
		die 'privileged Ansible tasks require sudo, but sudo is not installed'
	fi
	if [[ ! -t 0 ]]; then
		die 'privileged Ansible tasks require a terminal for sudo authentication'
	fi

	current_user="$(id -un)" || die 'could not determine the current user'
	for ((attempt = 1; attempt <= SUDO_PASSWORD_ATTEMPTS; attempt++)); do
		printf '[sudo] password for %s: ' "${current_user}" >&2
		if ! IFS= read -r -s inferred_ansible_become_pass; then
			printf '\n' >&2
			die 'could not read the sudo password'
		fi
		printf '\n' >&2

		if printf '%s\n' "${inferred_ansible_become_pass}" |
			sudo -S -k -p '' -v >/dev/null 2>&1; then
			return 0
		fi

		inferred_ansible_become_pass=''
		if ((attempt < SUDO_PASSWORD_ATTEMPTS)); then
			printf 'Sorry, try again.\n' >&2
		fi
	done

	die 'failed to validate sudo credentials for privileged Ansible tasks'
}

ensure_sudo_available() {
	local reason="$1"

	if ! command_exists sudo; then
		die "${reason} requires sudo, but sudo is not installed"
	fi

	if sudo -n -v >/dev/null 2>&1; then
		return 0
	fi

	# Never attempt an implicit password prompt in CI or redirected execution;
	# sudo can otherwise block forever while its input is unavailable.
	if [[ ! -t 0 ]]; then
		die "${reason} requires sudo; run this script from an interactive " \
			'terminal or pre-authenticate sudo with: sudo -v'
	fi

	printf '%s requires sudo; validating credentials now.\n' "${reason}" >&2
	if ! sudo -v; then
		die "failed to validate sudo credentials for ${reason}"
	fi
}

# Remove only the private directory created by create_temporary_directory.
# Globals:
#   temporary_directory
#   temporary_directory_parent
cleanup() {
	if [[ -z "${temporary_directory}" || ! -d "${temporary_directory}" ]]; then
		return 0
	fi

	case "${temporary_directory}" in
		"${temporary_directory_parent}"/dotfiles-bootstrap.*)
			rm -R "${temporary_directory}" ||
				warn "failed to remove temporary directory: ${temporary_directory}"
			;;
		*)
			warn "refusing to remove unexpected temporary path: ${temporary_directory}"
			;;
	esac

	temporary_directory=''
}

# Create a private temporary directory and register it for cleanup.
# Globals:
#   temporary_directory
#   temporary_directory_parent
create_temporary_directory() {
	local configured_parent="${TMPDIR:-/tmp}"

	if ! command_exists mktemp; then
		die 'mktemp is required to create a private temporary directory'
	fi

	if [[ "${configured_parent}" != /* || ! -d "${configured_parent}" ]]; then
		die "temporary directory parent is unavailable: ${configured_parent}"
	fi

	temporary_directory_parent="$(cd -P "${configured_parent}" && pwd -P)" ||
		die "failed to resolve temporary directory: ${configured_parent}"
	temporary_directory="$(
		mktemp -d "${temporary_directory_parent}/dotfiles-bootstrap.XXXXXX"
	)" || die \
		"failed to create a temporary directory under" \
		"${temporary_directory_parent}"
}

download_file() {
	local url="$1"
	local destination="$2"

	if command_exists curl; then
		curl -fsSL --retry "${DOWNLOAD_ATTEMPTS}" --retry-delay 1 \
			-o "${destination}" "${url}"
	elif command_exists wget; then
		wget --quiet --tries="${DOWNLOAD_ATTEMPTS}" --timeout=30 \
			--output-document="${destination}" "${url}"
	else
		die "neither curl nor wget is available to download ${url}"
	fi
}

verify_sha256() {
	local expected_sha256="${1#sha256:}"
	local path="$2"
	local hash_output
	local actual_sha256

	if [[ -z "${expected_sha256}" ]]; then
		return 0
	fi

	if ((${#expected_sha256} != 64)) ||
		[[ "${expected_sha256}" == *[!0123456789abcdefABCDEF]* ]]; then
		die "invalid sha256 checksum for ${path}"
	fi

	if command_exists sha256sum; then
		hash_output="$(sha256sum "${path}")" ||
			die "failed to hash ${path}"
	elif command_exists shasum; then
		hash_output="$(shasum -a 256 "${path}")" ||
			die "failed to hash ${path}"
	else
		die "sha256sum or shasum is required to verify ${path}"
	fi

	actual_sha256="${hash_output%% *}"
	expected_sha256="$(
		printf '%s\n' "${expected_sha256}" | tr '[:upper:]' '[:lower:]'
	)"
	actual_sha256="$(
		printf '%s\n' "${actual_sha256}" | tr '[:upper:]' '[:lower:]'
	)"
	if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
		die "checksum mismatch for ${path}: expected ${expected_sha256}," \
			"got ${actual_sha256}"
	fi
}

resolve_repository_root() {
	# BASH_SOURCE, rather than PWD, supports invocation from any directory and
	# deliberately follows the simulator's disposable repository symlink.
	local script_path="${BASH_SOURCE[0]}"
	local script_dir
	local repository_root
	local required_file

	if [[ "${script_path}" != */* ]]; then
		script_path="$(command -v "${script_path}")" ||
			die "failed to resolve script path: ${script_path}"
	fi

	script_dir="$(cd -P "$(dirname "${script_path}")" && pwd -P)" ||
		die 'failed to resolve script directory'
	repository_root="$(cd -P "${script_dir}/.." && pwd -P)" ||
		die 'failed to resolve repository directory'

	for required_file in "${REQUIRED_REPOSITORY_FILES[@]}"; do
		if [[ ! -f "${repository_root}/${required_file}" ]]; then
			die \
				"required repository file is missing:" \
				"${repository_root}/${required_file}"
		fi
	done

	printf '%s\n' "${repository_root}"
}

resolve_homebrew_prefix() {
	local operating_system="$1"
	local machine_architecture="$2"

	if [[ "${operating_system}" == 'Darwin' &&
		"${machine_architecture}" == 'x86_64' ]]; then
		# Homebrew would otherwise choose Intel paths while the playbook assumes
		# the native Apple Silicon prefix and packages.
		die \
			'this Apple Silicon setup must run from a native arm64 terminal,' \
			'not Rosetta'
	fi

	case "${operating_system}/${machine_architecture}" in
		Darwin/arm64) printf '%s\n' '/opt/homebrew' ;;
		Linux/*) printf '%s\n' '/home/linuxbrew/.linuxbrew' ;;
		*) die "unsupported bootstrap platform:" "${operating_system} ${machine_architecture}" ;;
	esac
}

validate_macos_version() {
	local operating_system="$1"
	local macos_version
	local macos_major_version

	if [[ "${operating_system}" != 'Darwin' ]]; then
		return 0
	fi
	if ! command_exists sw_vers; then
		die 'sw_vers is required to identify the macOS version'
	fi
	macos_version="$(sw_vers -productVersion)" ||
		die 'failed to identify the macOS version'
	macos_major_version="${macos_version%%.*}"
	if [[ -z "${macos_major_version}" ||
		"${macos_major_version}" == *[!0123456789]* ]]; then
		die "unexpected macOS version: ${macos_version}"
	fi
	if ((macos_major_version < MINIMUM_MACOS_MAJOR)); then
		die \
			"macOS ${MINIMUM_MACOS_MAJOR} or newer is required;" \
			"found ${macos_version}"
	fi
}

# Install Homebrew from a downloaded, optionally verified installer.
# Globals:
#   temporary_directory
ensure_homebrew() {
	local homebrew_prefix="$1"
	local homebrew_executable="$2"
	local operating_system="$3"
	local installer_file

	if [[ -x "${homebrew_executable}" ]]; then
		return 0
	fi
	if [[ "${operating_system}" == 'Linux' &&
		-f /usr/lib/systemd/system/brew-setup.service ]]; then
		ensure_sudo_available 'activating image-provisioned Homebrew'
		log 'Activating Homebrew provisioned by the Spectrum image'
		if ! sudo systemctl start brew-setup.service; then
			die 'the Spectrum brew-setup service failed'
		fi
		if [[ ! -x "${homebrew_executable}" ]]; then
			die \
				'the Spectrum image did not provision Homebrew;' \
				'rebuild and boot the current image before rerunning setup'
		fi
		return 0
	fi

	ensure_sudo_available 'installing Homebrew'
	create_temporary_directory
	installer_file="${temporary_directory}/homebrew-install.sh"

	log 'Downloading the Homebrew installer'
	if ! download_file "${HOMEBREW_INSTALLER_URL}" "${installer_file}"; then
		die "failed to download ${HOMEBREW_INSTALLER_URL}"
	fi
	verify_sha256 "${HOMEBREW_INSTALLER_CHECKSUM}" "${installer_file}"

	log "Installing Homebrew into ${homebrew_prefix}"
	if ! NONINTERACTIVE=1 /bin/bash "${installer_file}"; then
		die 'Homebrew installation failed'
	fi

	if [[ ! -x "${homebrew_executable}" ]]; then
		die "Homebrew did not create ${homebrew_executable}"
	fi

	cleanup
}

# Prepend Homebrew and, on macOS, GNU replacement tools to PATH.
# Outputs:
#   Exports PATH.
configure_homebrew_path() {
	local homebrew_prefix="$1"
	local homebrew_executable="$2"
	local operating_system="$3"
	local reported_prefix
	local path_suffix
	local path_entry
	local homebrew_path=''
	local -a path_entries=()

	reported_prefix="$("${homebrew_executable}" --prefix)" ||
		die 'failed to query the Homebrew prefix'
	if [[ "${reported_prefix}" != "${homebrew_prefix}" ]]; then
		die "Homebrew reported an unexpected prefix: ${reported_prefix}"
	fi

	# The playbook expects GNU behavior. Homebrew intentionally keg-prefixes
	# these replacements on macOS, so bootstrap them into PATH explicitly.
	if [[ "${operating_system}" == 'Darwin' ]]; then
		for path_suffix in "${MACOS_GNU_PATH_SUFFIXES[@]}"; do
			path_entries+=("${homebrew_prefix}/${path_suffix}")
		done
	fi
	path_entries+=("${homebrew_prefix}/bin" "${homebrew_prefix}/sbin")

	for path_entry in "${path_entries[@]}"; do
		homebrew_path="${homebrew_path:+${homebrew_path}:}${path_entry}"
	done
	PATH="${homebrew_path}:${PATH}"
	export PATH
}

install_homebrew_formulae() {
	local homebrew_executable="$1"
	local -a brew_args=(
		'install'
		'--formula'
	)
	brew_args+=("${HOMEBREW_FORMULAE[@]}")

	log "Installing Homebrew formulae: ${HOMEBREW_FORMULAE[*]}"
	# A caller may use this variable for normal brew operations, but bootstrap
	# must converge tool versions instead of silently retaining stale formulae.
	unset HOMEBREW_NO_INSTALL_UPGRADE
	if ! HOMEBREW_NO_ASK=1 "${homebrew_executable}" "${brew_args[@]}"; then
		die 'Homebrew formula installation failed'
	fi
}

install_macos_homebrew_casks() {
	local homebrew_executable="$1"
	local operating_system="$2"
	local -a brew_args=(
		'install'
		'--cask'
	)

	if [[ "${operating_system}" != 'Darwin' ]]; then
		return 0
	fi
	brew_args+=("${MACOS_HOMEBREW_CASKS[@]}")

	log "Installing Homebrew casks: ${MACOS_HOMEBREW_CASKS[*]}"
	unset HOMEBREW_NO_INSTALL_UPGRADE
	if ! HOMEBREW_NO_ASK=1 "${homebrew_executable}" "${brew_args[@]}"; then
		die 'Homebrew cask installation failed'
	fi
}

install_python_runtime() {
	local uv_executable="$1"
	local python_executable="$2"
	local python_alias
	local python_version_check

	python_version_check='import sys; '
	python_version_check+='expected = tuple(map(int, sys.argv[1].split("."))); '
	python_version_check+='raise SystemExit(sys.version_info[:2] != expected)'

	mkdir -p "${USER_EXECUTABLE_DIRECTORY}"
	log "Installing uv-managed Python ${PYTHON_VERSION}"
	if ! "${uv_executable}" --no-config python install "${PYTHON_VERSION}"; then
		die "failed to install Python ${PYTHON_VERSION}"
	fi

	if [[ ! -x "${python_executable}" ]] || ! "${python_executable}" \
		-c "${python_version_check}" "${PYTHON_VERSION}"; then
		die "uv did not provide Python ${PYTHON_VERSION} at ${python_executable}"
	fi

	# The playbook eventually converges python and python3 on uv's versioned
	# executable. Create missing aliases here so later bootstrap commands can use
	# conventional names before Ansible runs. Test both -e and -L because -e is
	# false for a broken link, which Ansible should replace rather than bootstrap
	# silently changing before the declarative phase.
	for python_alias in "${PYTHON_ALIASES[@]}"; do
		if [[ -e "${USER_EXECUTABLE_DIRECTORY}/${python_alias}" ]]; then
			continue
		fi
		if [[ -L "${USER_EXECUTABLE_DIRECTORY}/${python_alias}" ]]; then
			continue
		fi
		ln -s "${PYTHON_COMMAND}" "${USER_EXECUTABLE_DIRECTORY}/${python_alias}"
	done
}

install_python_tools() {
	local uv_executable="$1"
	local python_executable="$2"
	local repository_root="$3"
	local constraints
	if [[ -z "${temporary_directory}" ]]; then
		create_temporary_directory
	fi
	constraints="${temporary_directory}/automation-constraints.txt"
	"${uv_executable}" export --project "${repository_root}" --locked \
		--only-group automation --no-hashes --no-annotate --no-header \
		--output-file "${constraints}" || die 'failed to export locked automation tools'
	local -a uv_args=(
		--no-config tool install --python "${python_executable}"
		--no-python-downloads --force --compile-bytecode
		--constraints "${constraints}"
	)

	log 'Installing Python command-line tools'
	if ! "${uv_executable}" "${uv_args[@]}" \
		--with-executables-from ansible-core ansible; then
		die 'failed to install uv tool: ansible'
	fi
	if ! "${uv_executable}" "${uv_args[@]}" ansible-lint; then
		die 'failed to install uv tool: ansible-lint'
	fi
}

verify_ansible_runtime() {
	local command_name
	local ansible_version
	local ansible_playbook_executable
	ansible_playbook_executable="${USER_EXECUTABLE_DIRECTORY}/ansible-playbook"

	for command_name in "${REQUIRED_ANSIBLE_COMMANDS[@]}"; do
		if [[ ! -x "${USER_EXECUTABLE_DIRECTORY}/${command_name}" ]]; then
			die "uv did not create ${command_name} under ${USER_EXECUTABLE_DIRECTORY}"
		fi
	done

	ansible_version="$("${ansible_playbook_executable}" --version)" ||
		die 'failed to run uv-installed Ansible'
	if [[ "${ansible_version}" != *"python version = ${PYTHON_VERSION}."* ]]; then
		die "uv-installed Ansible is not running on Python ${PYTHON_VERSION}"
	fi
}

install_ansible_collections() {
	local ansible_galaxy_executable="$1"
	local repository_root="$2"
	local collection
	local collection_manifest
	local -a install_args=(
		'collection'
		'install'
		'--requirements-file'
		"${repository_root}/${ANSIBLE_REQUIREMENTS_FILE}"
		'--collections-path'
		"${repository_root}/${ANSIBLE_COLLECTIONS_DIRECTORY}"
	)

	for collection in "${REQUIRED_ANSIBLE_COLLECTIONS[@]}"; do
		# A previously interrupted install can leave the collection directory
		# present but unusable. Force repair when any required manifest is absent.
		collection_manifest="${repository_root}/"
		collection_manifest+="${ANSIBLE_COLLECTIONS_DIRECTORY}/"
		collection_manifest+="ansible_collections/${collection}/MANIFEST.json"
		if [[ ! -f "${collection_manifest}" ]]; then
			install_args+=('--force')
			break
		fi
	done

	log 'Installing Ansible collections'
	if ! "${ansible_galaxy_executable}" "${install_args[@]}"; then
		die 'Ansible collection installation failed'
	fi
}

run_ansible_playbook() {
	local ansible_playbook_executable="$1"
	shift
	local disable_become_prompt='false'
	local use_inferred_become_pass='false'
	local -a playbook_args=("${ANSIBLE_PLAYBOOK}" "$@")

	if needs_ansible_become_prompt "${playbook_args[@]}"; then
		capture_ansible_become_password
		disable_become_prompt='true'
		use_inferred_become_pass='true'
	elif ! has_ansible_become_prompt_arg "${playbook_args[@]}" &&
		[[ -z "${ANSIBLE_BECOME_ASK_PASS:-}" ]]; then
		disable_become_prompt='true'
	fi

	cleanup
	# The installer temp directory is no longer useful here. Removing it before
	# a potentially long playbook also narrows the lifetime of downloaded code.
	log "Running Ansible playbook: ${ANSIBLE_PLAYBOOK}"
	if [[ "${use_inferred_become_pass}" == 'true' ]]; then
		ANSIBLE_BECOME_ASK_PASS='false' \
			ANSIBLE_BECOME_PASS="${inferred_ansible_become_pass}" \
			"${ansible_playbook_executable}" "${playbook_args[@]}"
	elif [[ "${disable_become_prompt}" == 'true' ]]; then
		ANSIBLE_BECOME_ASK_PASS='false' \
			"${ansible_playbook_executable}" "${playbook_args[@]}"
	else
		"${ansible_playbook_executable}" "${playbook_args[@]}"
	fi
}

# Bound SOPS because its 1Password helper can wait indefinitely for desktop
# approval. gtimeout comes from the coreutils package installed in stage 10.
private_settings_are_accessible() {
	local repository_root="$1"
	local sops_executable="$2"
	local timeout_executable="$3"
	local timeout_seconds="$4"
	local age_key_helper="${repository_root}/${MACOS_AGE_KEY_HELPER_FILE}"

	SOPS_AGE_KEY_CMD="${age_key_helper}" \
		"${timeout_executable}" --kill-after=5s "${timeout_seconds}s" \
		"${sops_executable}" decrypt "${repository_root}/${PRIVATE_SETTINGS_FILE}" \
		>/dev/null
}

ensure_private_settings_access() {
	local homebrew_prefix="$1"
	local repository_root="$2"
	local sops_executable="${homebrew_prefix}/bin/sops"
	local timeout_executable="${homebrew_prefix}/bin/gtimeout"
	local initial_timeout='5'

	if [[ ! -x "${sops_executable}" ]]; then
		die "the bootstrap playbook did not install sops at ${sops_executable}"
	fi
	if [[ ! -x "${timeout_executable}" ]]; then
		die "the bootstrap playbook did not install gtimeout at ${timeout_executable}"
	fi
	if [[ -t 0 ]]; then
		initial_timeout='60'
	fi
	log 'Checking access to private settings (1Password may request approval)'
	if private_settings_are_accessible \
		"${repository_root}" "${sops_executable}" \
		"${timeout_executable}" "${initial_timeout}"; then
		return 0
	fi
	if [[ ! -t 0 ]]; then
		die \
			'private settings are unavailable; run --setup interactively' \
			'and sign in to 1Password'
	fi

	log 'Waiting for access to private settings'
	if command_exists open && ! open -a '1Password'; then
		warn 'could not open 1Password automatically'
	fi
	printf '%s\n' \
		'Sign in to and unlock 1Password, then enable:' \
		'Settings > Developer > Integrate with 1Password CLI.'
	printf 'Press Return to continue: '
	if ! IFS= read -r _; then
		die 'could not read confirmation for 1Password setup'
	fi
	if ! private_settings_are_accessible \
		"${repository_root}" "${sops_executable}" \
		"${timeout_executable}" '60'; then
		die 'private settings are still unavailable from 1Password'
	fi
}

verify_setup_prerequisites() {
	local homebrew_prefix="$1"
	local repository_root="$2"
	local operating_system="$3"
	local just_executable="${homebrew_prefix}/bin/just"

	# Homebrew installs the macOS 1Password app and CLI in stage 10. Pause
	# between package installation and private application configuration so a
	# genuinely fresh host can establish credential access in one run.
	if [[ ! -x "${just_executable}" ]]; then
		die "the bootstrap playbook did not install just at ${just_executable}"
	fi
	if [[ "${operating_system}" == 'Darwin' ]]; then
		ensure_private_settings_access "${homebrew_prefix}" "${repository_root}"
	fi
}

execute_setup_plan() {
	local ansible_playbook_executable="$1"
	local homebrew_prefix="$2"
	local repository_root="$3"
	local operating_system="$4"

	# Each playbook invocation checks credentials again after long setup stages.
	run_ansible_playbook "${ansible_playbook_executable}" --tags stage-10,stage-20
	verify_setup_prerequisites \
		"${homebrew_prefix}" "${repository_root}" "${operating_system}"
	run_ansible_playbook "${ansible_playbook_executable}" --tags stage-30
	log 'Applying chezmoi dotfiles'
	"${homebrew_prefix}/bin/just" --justfile "${repository_root}/Justfile" apply
	run_ansible_playbook "${ansible_playbook_executable}" --tags host
}

# NixOS supplies the runtime and programs through the active system generation.
# Only collections, home files, and the live keyboard session need reconciliation.
run_nixos_bootstrap() {
	local repository_root="$1"
	local setup_requested="$2"
	shift 2
	local system_bin='/run/current-system/sw/bin'
	local executable

	for executable in ansible-galaxy ansible-playbook just; do
		if [[ ! -x "${system_bin}/${executable}" ]]; then
			die "rebuild the NixOS configuration first: missing ${system_bin}/${executable}"
		fi
	done
	cd "${repository_root}" || die "failed to enter repository: ${repository_root}"
	install_ansible_collections "${system_bin}/ansible-galaxy" "${repository_root}"
	if [[ "${setup_requested}" == 'true' ]]; then
		"${system_bin}/just" --justfile "${repository_root}/Justfile" apply
		run_ansible_playbook "${system_bin}/ansible-playbook" --tags host
	else
		run_ansible_playbook "${system_bin}/ansible-playbook" "$@"
	fi
}

main() {
	local repository_root
	local operating_system
	local machine_architecture
	local homebrew_prefix
	local homebrew_executable
	local uv_executable
	local python_executable
	local ansible_galaxy_executable="${USER_EXECUTABLE_DIRECTORY}/ansible-galaxy"
	local ansible_playbook_executable
	local setup_requested='false'
	ansible_playbook_executable="${USER_EXECUTABLE_DIRECTORY}/ansible-playbook"

	case "${1:-}" in
		--setup)
			if (($# != 1)); then
				die '--setup does not accept additional Ansible arguments'
			fi
			setup_requested='true'
			shift
			;;
		-h | --help)
			usage
			return 0
			;;
	esac

	if ((EUID == 0)); then
		die 'do not run the bootstrap as root; it uses sudo only when required'
	fi

	trap cleanup EXIT
	trap 'exit 1' HUP INT TERM

	validate_configuration
	repository_root="$(resolve_repository_root)"
	operating_system="$(uname -s)"
	if [[ "${operating_system}" == Linux && -e /etc/NIXOS ]]; then
		run_nixos_bootstrap "${repository_root}" "${setup_requested}" "$@"
		return
	fi
	machine_architecture="$(uname -m)"
	validate_macos_version "${operating_system}"
	homebrew_prefix="$(
		resolve_homebrew_prefix "${operating_system}" "${machine_architecture}"
	)"
	homebrew_executable="${homebrew_prefix}/bin/brew"
	uv_executable="${homebrew_prefix}/bin/uv"
	python_executable="${USER_EXECUTABLE_DIRECTORY}/${PYTHON_COMMAND}"

	ensure_homebrew \
		"${homebrew_prefix}" "${homebrew_executable}" "${operating_system}"
	configure_homebrew_path \
		"${homebrew_prefix}" "${homebrew_executable}" "${operating_system}"
	install_homebrew_formulae "${homebrew_executable}"
	if [[ "${setup_requested}" == 'true' ]]; then
		install_macos_homebrew_casks \
			"${homebrew_executable}" "${operating_system}"
	fi
	if [[ ! -x "${uv_executable}" ]]; then
		die "Homebrew did not create uv at ${uv_executable}"
	fi

	install_python_runtime "${uv_executable}" "${python_executable}"
	install_python_tools "${uv_executable}" "${python_executable}" "${repository_root}"

	PATH="${USER_EXECUTABLE_DIRECTORY}:${PATH}"
	export PATH
	verify_ansible_runtime

	cd "${repository_root}" || die "failed to enter repository: ${repository_root}"
	install_ansible_collections \
		"${ansible_galaxy_executable}" "${repository_root}"
	if [[ "${setup_requested}" == 'true' ]]; then
		execute_setup_plan \
			"${ansible_playbook_executable}" \
			"${homebrew_prefix}" \
			"${repository_root}" \
			"${operating_system}"
	else
		run_ansible_playbook "${ansible_playbook_executable}" "$@"
	fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	main "$@"
fi
