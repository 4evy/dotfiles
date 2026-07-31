#!/bin/bash
#
# Prepare a fresh macOS or Linux host and run this repository's Ansible
# playbook. Keep bootstrap policy in the readonly data below; the functions
# only interpret that policy and orchestrate system-provided command-line tools.

set -euo pipefail

readonly SITE_PLAYBOOK='ansible/site.yml'
readonly ANSIBLE_REQUIREMENTS='ansible/requirements.yml'
readonly ANSIBLE_COLLECTIONS_PATH='.ansible/collections'
readonly PYTHON_VERSION='3.14'
readonly PYTHON_COMMAND="python${PYTHON_VERSION}"
readonly USER_BIN_DIR="${HOME}/.local/bin"
readonly DEFAULT_HOMEBREW_INSTALLER_URL='https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh'
HOMEBREW_INSTALLER_URL="${HOMEBREW_INSTALLER_URL:-}"
if [[ -z "${HOMEBREW_INSTALLER_URL}" ]]; then
	HOMEBREW_INSTALLER_URL="${DEFAULT_HOMEBREW_INSTALLER_URL}"
fi
readonly HOMEBREW_INSTALLER_URL
readonly HOMEBREW_INSTALLER_CHECKSUM="${HOMEBREW_INSTALLER_CHECKSUM:-}"

# Bash 3.2 has indexed arrays but no associative arrays. These aligned arrays
# model records without delimiter parsing and still work with macOS's Bash.
readonly -a HOMEBREW_PLATFORM_KERNELS=(
	'Darwin'
	'Darwin'
	'Linux'
)
readonly -a HOMEBREW_PLATFORM_ARCHITECTURES=(
	'arm64'
	'x86_64'
	'*'
)
readonly -a HOMEBREW_PLATFORM_PREFIXES=(
	'/opt/homebrew'
	'/usr/local'
	'/home/linuxbrew/.linuxbrew'
)

readonly -a HOMEBREW_FORMULAE=(
	'uv'
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

# Each UV_TOOL_SPEC has a corresponding executable provider. An empty provider
# means that the package itself owns every executable being installed.
readonly -a UV_TOOL_SPECS=(
	'ansible>=14,<15'
	'ansible-lint>=26,<27'
)
readonly -a UV_TOOL_EXECUTABLE_PROVIDERS=(
	'ansible-core'
	''
)

readonly -a REQUIRED_ANSIBLE_COMMANDS=(
	'ansible-galaxy'
	'ansible-lint'
	'ansible-playbook'
)

readonly -a REQUIRED_REPOSITORY_FILES=(
	"${SITE_PLAYBOOK}"
	"${ANSIBLE_REQUIREMENTS}"
)

UV_PYTHON_BIN_DIR="${USER_BIN_DIR}"
UV_TOOL_BIN_DIR="${USER_BIN_DIR}"
readonly UV_PYTHON_BIN_DIR UV_TOOL_BIN_DIR
export UV_PYTHON_BIN_DIR UV_TOOL_BIN_DIR

# Mutable state is limited to the private directory tracked by exit traps.
tmp_dir=''
tmp_dir_parent=''

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

have_command() {
	command -v "$1" >/dev/null 2>&1
}

# Validate every declarative record before it can affect the host.
validate_configuration() {
	local index
	local platform_count="${#HOMEBREW_PLATFORM_KERNELS[@]}"
	local uv_tool_count="${#UV_TOOL_SPECS[@]}"

	if ((platform_count != ${#HOMEBREW_PLATFORM_ARCHITECTURES[@]})); then
		die 'Homebrew platform configuration has unaligned fields'
	fi
	if ((platform_count != ${#HOMEBREW_PLATFORM_PREFIXES[@]})); then
		die 'Homebrew platform configuration has unaligned fields'
	fi
	if ((uv_tool_count != ${#UV_TOOL_EXECUTABLE_PROVIDERS[@]})); then
		die 'uv tool configuration has unaligned fields'
	fi

	if ((${#HOMEBREW_FORMULAE[@]} == 0)); then
		die 'bootstrap configuration contains an empty required list'
	fi
	if ((uv_tool_count == 0)); then
		die 'bootstrap configuration contains an empty required list'
	fi
	if ((${#REQUIRED_ANSIBLE_COMMANDS[@]} == 0)); then
		die 'bootstrap configuration contains an empty required list'
	fi
	if ((${#REQUIRED_REPOSITORY_FILES[@]} == 0)); then
		die 'bootstrap configuration contains an empty required list'
	fi

	for ((index = 0; index < platform_count; index++)); do
		if [[ -z "${HOMEBREW_PLATFORM_KERNELS[index]}" ]]; then
			die "invalid Homebrew platform record at index ${index}"
		fi
		if [[ -z "${HOMEBREW_PLATFORM_ARCHITECTURES[index]}" ]]; then
			die "invalid Homebrew platform record at index ${index}"
		fi
		if [[ "${HOMEBREW_PLATFORM_PREFIXES[index]}" != /* ]]; then
			die "invalid Homebrew platform record at index ${index}"
		fi
	done

	for ((index = 0; index < uv_tool_count; index++)); do
		if [[ -z "${UV_TOOL_SPECS[index]}" ]]; then
			die "empty uv tool specification at index ${index}"
		fi
	done
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

ansible_become_prompt_enabled() {
	case "${ANSIBLE_BECOME_ASK_PASS:-}" in
		1 | true | TRUE | yes | YES | on | ON) return 0 ;;
		*) return 1 ;;
	esac
}

needs_ansible_become_prompt() {
	[[ -t 0 ]] || return 1
	[[ -z "${ANSIBLE_BECOME_PASSWORD:-}" ]] || return 1
	[[ -z "${ANSIBLE_BECOME_PASS:-}" ]] || return 1
	ansible_become_prompt_enabled && return 1
	has_ansible_become_prompt_arg "$@" && return 1

	if have_command sudo && sudo -n -v >/dev/null 2>&1; then
		return 1
	fi

	return 0
}

ensure_sudo_available() {
	local reason="$1"

	if ! have_command sudo; then
		die "${reason} requires sudo, but sudo is not installed"
	fi

	if sudo -n -v >/dev/null 2>&1; then
		return 0
	fi

	if [[ ! -t 0 ]]; then
		die "${reason} requires sudo; run this script from an interactive " \
			'terminal or pre-authenticate sudo with: sudo -v'
	fi

	printf '%s requires sudo; validating credentials now.\n' "${reason}" >&2
	if ! sudo -v; then
		die "failed to validate sudo credentials for ${reason}"
	fi
}

# Remove only the private directory created by make_tmp_dir.
# Globals:
#   tmp_dir
#   tmp_dir_parent
cleanup() {
	if [[ -z "${tmp_dir}" || ! -d "${tmp_dir}" ]]; then
		return 0
	fi

	case "${tmp_dir}" in
		"${tmp_dir_parent}"/dotfiles-bootstrap.*)
			rm -R "${tmp_dir}" ||
				warn "failed to remove temporary directory: ${tmp_dir}"
			;;
		*)
			warn "refusing to remove unexpected temporary path: ${tmp_dir}"
			;;
	esac

	tmp_dir=''
}

# Create a private temporary directory and register it for cleanup.
# Globals:
#   tmp_dir
#   tmp_dir_parent
make_tmp_dir() {
	local configured_parent="${TMPDIR:-/tmp}"

	if ! have_command mktemp; then
		die 'mktemp is required to create a private temporary directory'
	fi

	if [[ "${configured_parent}" != /* || ! -d "${configured_parent}" ]]; then
		die "temporary directory parent is unavailable: ${configured_parent}"
	fi

	tmp_dir_parent="$(cd -P "${configured_parent}" && pwd -P)" ||
		die "failed to resolve temporary directory: ${configured_parent}"
	tmp_dir="$(mktemp -d "${tmp_dir_parent}/dotfiles-bootstrap.XXXXXX")" ||
		die "failed to create a temporary directory under ${tmp_dir_parent}"
}

download_file() {
	local url="$1"
	local destination="$2"

	if have_command curl; then
		curl -fsSL -o "${destination}" "${url}"
	elif have_command wget; then
		wget -qO "${destination}" "${url}"
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

	if have_command sha256sum; then
		hash_output="$(sha256sum "${path}")" ||
			die "failed to hash ${path}"
	elif have_command shasum; then
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

resolve_repository() {
	local script_path="${BASH_SOURCE[0]}"
	local script_dir
	local repo_dir
	local required_file

	if [[ "${script_path}" != */* ]]; then
		script_path="$(command -v "${script_path}")" ||
			die "failed to resolve script path: ${script_path}"
	fi

	script_dir="$(cd -P "$(dirname "${script_path}")" && pwd -P)" ||
		die 'failed to resolve script directory'
	repo_dir="$(cd -P "${script_dir}/.." && pwd -P)" ||
		die 'failed to resolve repository directory'

	for required_file in "${REQUIRED_REPOSITORY_FILES[@]}"; do
		if [[ ! -f "${repo_dir}/${required_file}" ]]; then
			die "required repository file is missing: ${repo_dir}/${required_file}"
		fi
	done

	printf '%s\n' "${repo_dir}"
}

select_homebrew_prefix() {
	local kernel_name="$1"
	local machine_architecture="$2"
	local configured_architecture
	local index

	for ((index = 0; index < ${#HOMEBREW_PLATFORM_KERNELS[@]}; index++)); do
		if [[ "${HOMEBREW_PLATFORM_KERNELS[index]}" != "${kernel_name}" ]]; then
			continue
		fi
		configured_architecture="${HOMEBREW_PLATFORM_ARCHITECTURES[index]}"
		if [[ "${configured_architecture}" != '*' &&
			"${configured_architecture}" != "${machine_architecture}" ]]; then
			continue
		fi

		printf '%s\n' "${HOMEBREW_PLATFORM_PREFIXES[index]}"
		return 0
	done

	die "unsupported bootstrap platform: ${kernel_name} ${machine_architecture}"
}

# Install Homebrew from a downloaded, optionally verified installer.
# Globals:
#   tmp_dir
ensure_homebrew() {
	local homebrew_prefix="$1"
	local homebrew_bin="$2"
	local installer_file

	if [[ -x "${homebrew_bin}" ]]; then
		return 0
	fi

	ensure_sudo_available 'installing Homebrew'
	make_tmp_dir
	installer_file="${tmp_dir}/homebrew-install.sh"

	log 'Downloading the Homebrew installer'
	if ! download_file "${HOMEBREW_INSTALLER_URL}" "${installer_file}"; then
		die "failed to download ${HOMEBREW_INSTALLER_URL}"
	fi
	verify_sha256 "${HOMEBREW_INSTALLER_CHECKSUM}" "${installer_file}"

	log "Installing Homebrew into ${homebrew_prefix}"
	if ! NONINTERACTIVE=1 /bin/bash "${installer_file}"; then
		die 'Homebrew installation failed'
	fi

	if [[ ! -x "${homebrew_bin}" ]]; then
		die "Homebrew did not create ${homebrew_bin}"
	fi

	cleanup
}

# Prepend Homebrew and, on macOS, GNU replacement tools to PATH.
# Outputs:
#   Exports PATH.
activate_homebrew() {
	local homebrew_prefix="$1"
	local homebrew_bin="$2"
	local kernel_name="$3"
	local reported_prefix
	local path_suffix
	local path_entry
	local homebrew_path=''
	local -a path_entries=()

	reported_prefix="$("${homebrew_bin}" --prefix)" ||
		die 'failed to query the Homebrew prefix'
	if [[ "${reported_prefix}" != "${homebrew_prefix}" ]]; then
		die "Homebrew reported an unexpected prefix: ${reported_prefix}"
	fi

	if [[ "${kernel_name}" == 'Darwin' ]]; then
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
	local homebrew_bin="$1"
	local -a brew_args=(
		'install'
		'--formula'
	)
	brew_args+=("${HOMEBREW_FORMULAE[@]}")

	log "Installing Homebrew formulae: ${HOMEBREW_FORMULAE[*]}"
	unset HOMEBREW_NO_INSTALL_UPGRADE
	if ! HOMEBREW_NO_ASK=1 "${homebrew_bin}" "${brew_args[@]}"; then
		die 'Homebrew formula installation failed'
	fi
}

install_python() {
	local uv_bin="$1"
	local python_bin="$2"
	local python_alias
	local python_version_check

	python_version_check='import sys; '
	python_version_check+='expected = tuple(map(int, sys.argv[1].split("."))); '
	python_version_check+='raise SystemExit(sys.version_info[:2] != expected)'

	mkdir -p "${USER_BIN_DIR}"
	log "Installing uv-managed Python ${PYTHON_VERSION}"
	if ! "${uv_bin}" python install "${PYTHON_VERSION}"; then
		die "failed to install Python ${PYTHON_VERSION}"
	fi

	if [[ ! -x "${python_bin}" ]] ||
		! "${python_bin}" -c "${python_version_check}" "${PYTHON_VERSION}"; then
		die "uv did not provide Python ${PYTHON_VERSION} at ${python_bin}"
	fi

	# The playbook eventually replaces python and python3 with repository-owned
	# wrappers, so uv's --default mode would overwrite intentional links.
	for python_alias in "${PYTHON_ALIASES[@]}"; do
		if [[ -e "${USER_BIN_DIR}/${python_alias}" ]]; then
			continue
		fi
		if [[ -L "${USER_BIN_DIR}/${python_alias}" ]]; then
			continue
		fi
		ln -s "${PYTHON_COMMAND}" "${USER_BIN_DIR}/${python_alias}"
	done
}

install_uv_tools() {
	local uv_bin="$1"
	local python_bin="$2"
	local index
	local tool_spec
	local executable_provider
	local -a uv_args

	log 'Installing Python command-line tools'
	for ((index = 0; index < ${#UV_TOOL_SPECS[@]}; index++)); do
		tool_spec="${UV_TOOL_SPECS[index]}"
		executable_provider="${UV_TOOL_EXECUTABLE_PROVIDERS[index]}"
		uv_args=(
			'tool'
			'install'
			'--python'
			"${python_bin}"
			'--no-python-downloads'
			'--force'
			'--compile-bytecode'
		)
		if [[ -n "${executable_provider}" ]]; then
			uv_args+=(
				'--with-executables-from'
				"${executable_provider}"
			)
		fi
		uv_args+=("${tool_spec}")

		if ! "${uv_bin}" "${uv_args[@]}"; then
			die "failed to install uv tool: ${tool_spec}"
		fi
	done
}

verify_ansible_installation() {
	local command_name
	local ansible_version
	local ansible_playbook_bin="${USER_BIN_DIR}/ansible-playbook"

	for command_name in "${REQUIRED_ANSIBLE_COMMANDS[@]}"; do
		if [[ ! -x "${USER_BIN_DIR}/${command_name}" ]]; then
			die "uv did not create ${command_name} under ${USER_BIN_DIR}"
		fi
	done

	ansible_version="$("${ansible_playbook_bin}" --version)" ||
		die 'failed to run uv-installed Ansible'
	if [[ "${ansible_version}" != *"python version = ${PYTHON_VERSION}."* ]]; then
		die "uv-installed Ansible is not running on Python ${PYTHON_VERSION}"
	fi
}

install_ansible_collections() {
	local ansible_galaxy_bin="$1"
	local repo_dir="$2"

	log 'Installing Ansible collections'
	if ! "${ansible_galaxy_bin}" collection install \
		--requirements-file "${repo_dir}/${ANSIBLE_REQUIREMENTS}" \
		--collections-path "${repo_dir}/${ANSIBLE_COLLECTIONS_PATH}"; then
		die 'Ansible collection installation failed'
	fi
}

run_playbook() {
	local ansible_playbook_bin="$1"
	shift
	local -a playbook_args=("${SITE_PLAYBOOK}" "$@")

	if needs_ansible_become_prompt "${playbook_args[@]}"; then
		playbook_args=('--ask-become-pass' "${playbook_args[@]}")
	elif ! has_ansible_become_prompt_arg "${playbook_args[@]}" &&
		[[ -z "${ANSIBLE_BECOME_ASK_PASS:-}" ]]; then
		ANSIBLE_BECOME_ASK_PASS='false'
		export ANSIBLE_BECOME_ASK_PASS
	fi

	cleanup
	trap - EXIT HUP INT TERM
	log "Running Ansible playbook: ${SITE_PLAYBOOK}"
	exec "${ansible_playbook_bin}" "${playbook_args[@]}"
}

main() {
	local repo_dir
	local kernel_name
	local machine_architecture
	local homebrew_prefix
	local homebrew_bin
	local uv_bin
	local python_bin
	local ansible_galaxy_bin="${USER_BIN_DIR}/ansible-galaxy"
	local ansible_playbook_bin="${USER_BIN_DIR}/ansible-playbook"

	trap cleanup EXIT
	trap 'exit 1' HUP INT TERM

	validate_configuration
	repo_dir="$(resolve_repository)"
	kernel_name="$(uname -s)"
	machine_architecture="$(uname -m)"
	homebrew_prefix="$(
		select_homebrew_prefix "${kernel_name}" "${machine_architecture}"
	)"
	homebrew_bin="${homebrew_prefix}/bin/brew"
	uv_bin="${homebrew_prefix}/bin/uv"
	python_bin="${USER_BIN_DIR}/${PYTHON_COMMAND}"

	ensure_homebrew "${homebrew_prefix}" "${homebrew_bin}"
	activate_homebrew "${homebrew_prefix}" "${homebrew_bin}" "${kernel_name}"
	install_homebrew_formulae "${homebrew_bin}"
	if [[ ! -x "${uv_bin}" ]]; then
		die "Homebrew did not create uv at ${uv_bin}"
	fi

	install_python "${uv_bin}" "${python_bin}"
	install_uv_tools "${uv_bin}" "${python_bin}"

	PATH="${USER_BIN_DIR}:${PATH}"
	export PATH
	verify_ansible_installation

	cd "${repo_dir}" || die "failed to enter repository: ${repo_dir}"
	install_ansible_collections "${ansible_galaxy_bin}" "${repo_dir}"
	run_playbook "${ansible_playbook_bin}" "$@"
}

main "$@"
