#!/bin/sh
# shellcheck shell=sh
#
# This entrypoint is meant to run first on a fresh system. Assume that host is
# still "poor": few packages, no preferred shell, and only baseline Unix tools.
# Keep this script POSIX sh, self-contained, and conservative about every
# external command it relies on.
set -eu

site_playbook=ansible/site.yml
ansible_requirements=ansible/requirements.yml
ansible_collections_path=.ansible/collections
homebrew_installer_url=https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh
homebrew_installer_checksum=${HOMEBREW_INSTALLER_CHECKSUM-}
ansible_tool_spec='ansible>=14,<15'
ansible_lint_tool_spec='ansible-lint>=26,<27'

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

have_command() {
	command -v "$1" >/dev/null 2>&1
}

has_ansible_become_prompt_arg() {
	for arg; do
		case $arg in
			--ask-become-pass | -K | --become-password-file | --become-password-file=* | --become-pass-file | --become-pass-file=*)
				return 0
				;;
		esac
	done

	return 1
}

needs_ansible_become_prompt() {
	[ -t 0 ] &&
		[ -z "${ANSIBLE_BECOME_PASSWORD-}" ] &&
		[ -z "${ANSIBLE_BECOME_PASS-}" ] &&
		! has_ansible_become_prompt_arg "$@" &&
		! { have_command sudo && sudo -n -v >/dev/null 2>&1; }
}

ensure_sudo_available() {
	if [ "$#" -ne 1 ]; then
		die "ensure_sudo_available expects a reason"
	fi

	sudo_reason=$1

	if ! have_command sudo; then
		die "$sudo_reason requires sudo, but sudo is not installed"
	fi

	if sudo -n -v >/dev/null 2>&1; then
		return 0
	fi

	if [ ! -t 0 ]; then
		die "$sudo_reason requires sudo; run this script from an interactive terminal or pre-authenticate sudo with: sudo -v"
	fi

	printf '%s requires sudo; validating credentials now.\n' "$sudo_reason" >&2
	sudo -v ||
		die "failed to validate sudo credentials for $sudo_reason"
}

cleanup() {
	if [ "${tmp_dir_created-}" = 1 ] &&
		[ -n "${tmp_dir-}" ] &&
		[ -n "${tmp_dir_parent-}" ] &&
		[ -d "$tmp_dir" ]; then
		case $tmp_dir in
			"$tmp_dir_parent"/dotfiles-bootstrap.*)
				rm -rf "$tmp_dir"
				;;
			*)
				printf 'warning: refusing to remove unexpected temporary path: %s\n' "$tmp_dir" >&2
				;;
		esac
	fi
	tmp_dir=
	tmp_dir_parent=
	tmp_dir_created=
}

make_tmp_dir() {
	tmp_dir_parent=${TMPDIR:-/tmp}
	if [ -z "$tmp_dir_parent" ]; then
		tmp_dir_parent=/tmp
	fi

	case $tmp_dir_parent in
		/*) ;;
		*) die "TMPDIR must be an absolute path: $tmp_dir_parent" ;;
	esac

	if [ ! -d "$tmp_dir_parent" ]; then
		die "temporary directory parent does not exist: $tmp_dir_parent"
	fi

	tmp_umask=$(umask) ||
		die "failed to read umask"
	umask 077 ||
		die "failed to set private umask"

	tmp_try=0
	while [ "$tmp_try" -lt 50 ]; do
		tmp_dir=$tmp_dir_parent/dotfiles-bootstrap.$$.$tmp_try
		if mkdir "$tmp_dir" 2>/dev/null; then
			tmp_dir_created=1
			umask "$tmp_umask" ||
				die "failed to restore umask"
			return 0
		fi
		tmp_try=$((tmp_try + 1))
	done

	umask "$tmp_umask" ||
		die "failed to restore umask"
	tmp_dir=
	die "failed to create a temporary directory under $tmp_dir_parent"
}

download_file() {
	if [ "$#" -ne 2 ]; then
		die "download_file expects a URL and destination path"
	fi

	download_url=$1
	download_dest=$2

	if [ -z "$download_url" ] || [ -z "$download_dest" ]; then
		die "download_file received an empty URL or destination path"
	fi

	if have_command curl; then
		curl -fsSL -o "$download_dest" "$download_url"
	elif have_command wget; then
		wget -qO "$download_dest" "$download_url"
	else
		die "neither curl nor wget is available to download $download_url"
	fi
}

verify_sha256() {
	if [ "$#" -ne 2 ]; then
		die "verify_sha256 expects an expected hash and file path"
	fi

	expected_sha256=$1
	sha256_path=$2

	case $expected_sha256 in
		sha256:*) expected_sha256=${expected_sha256#sha256:} ;;
	esac

	if [ -z "$expected_sha256" ]; then
		return 0
	fi

	if have_command sha256sum; then
		actual_sha256=$(sha256sum "$sha256_path") ||
			die "failed to hash $sha256_path"
	elif have_command shasum; then
		actual_sha256=$(shasum -a 256 "$sha256_path") ||
			die "failed to hash $sha256_path"
	else
		die "sha256sum or shasum is required to verify $sha256_path"
	fi
	actual_sha256=${actual_sha256%% *}

	if [ "$actual_sha256" != "$expected_sha256" ]; then
		die "checksum mismatch for $sha256_path: expected $expected_sha256, got $actual_sha256"
	fi
}

download_and_run() {
	if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
		die "download_and_run expects an installer URL, shell path, and optional sha256"
	fi

	installer_url=$1
	installer_shell=$2
	installer_checksum=${3-}

	if [ -z "$installer_url" ] || [ -z "$installer_shell" ]; then
		die "download_and_run received an empty installer URL or shell path"
	fi

	if [ -z "${tmp_dir-}" ]; then
		make_tmp_dir
	fi

	installer_file=$tmp_dir/installer.sh
	download_file "$installer_url" "$installer_file"
	verify_sha256 "$installer_checksum" "$installer_file"
	"$installer_shell" "$installer_file"
}

install_ansible_collections() {
	if [ "$#" -ne 1 ]; then
		die "install_ansible_collections expects an ansible-galaxy path"
	fi

	ansible_galaxy_bin=$1

	if [ -f "$repo_dir/$ansible_requirements" ]; then
		"$ansible_galaxy_bin" collection install \
			--requirements-file "$repo_dir/$ansible_requirements" \
			--collections-path "$repo_dir/$ansible_collections_path"
	fi
}

script_path=$0
case $script_path in
	*/*) ;;
	*)
		script_path=$(command -v "$script_path") ||
			die "failed to resolve script path: $0"
		;;
esac

script_dir=$(
	CDPATH=
	cd -P "$(dirname "$script_path")" && pwd -P
) ||
	die "failed to resolve script directory"
repo_dir=$(
	CDPATH=
	cd -P "$script_dir/.." && pwd -P
) ||
	die "failed to resolve repository directory"

trap cleanup 0
trap 'cleanup; exit 1' HUP INT TERM

kernel_name=$(uname -s)
machine_arch=$(uname -m)

case $kernel_name in
	Darwin | Linux) ;;
	*) die "unsupported operating system for this bootstrap: $kernel_name" ;;
esac

case $kernel_name in
	Darwin)
		case $machine_arch in
			arm64)
				homebrew_prefix=/opt/homebrew
				;;
			x86_64)
				homebrew_prefix=/usr/local
				;;
			*)
				die "unsupported macOS architecture for Homebrew: $machine_arch"
				;;
		esac
		homebrew_path=$homebrew_prefix/opt/coreutils/libexec/gnubin:$homebrew_prefix/opt/findutils/libexec/gnubin:$homebrew_prefix/opt/gnu-sed/libexec/gnubin:$homebrew_prefix/opt/grep/libexec/gnubin:$homebrew_prefix/opt/gawk/libexec/gnubin:$homebrew_prefix/opt/gnu-tar/libexec/gnubin:$homebrew_prefix/opt/gnu-which/libexec/gnubin:$homebrew_prefix/opt/diffutils/libexec/gnubin:$homebrew_prefix/opt/make/libexec/gnubin:$homebrew_prefix/opt/gnu-getopt/bin:$homebrew_prefix/bin:$homebrew_prefix/sbin:$PATH
		;;
	Linux)
		homebrew_prefix=/home/linuxbrew/.linuxbrew
		homebrew_path=$homebrew_prefix/bin:$homebrew_prefix/sbin:$PATH
		;;
esac

homebrew_bin=$homebrew_prefix/bin/brew
if [ ! -x "$homebrew_bin" ]; then
	ensure_sudo_available "installing Homebrew"

	NONINTERACTIVE=1
	export NONINTERACTIVE
	download_and_run \
		"$homebrew_installer_url" \
		/bin/bash \
		"$homebrew_installer_checksum"
fi

PATH=$homebrew_path
HOMEBREW_NO_ASK=1
export PATH
export HOMEBREW_NO_ASK

unset HOMEBREW_NO_INSTALL_UPGRADE
"$homebrew_bin" install uv
uv_bin=$homebrew_prefix/bin/uv
if [ ! -x "$uv_bin" ]; then
	die "Homebrew did not create uv at $uv_bin"
fi

# Leave the OS-owned bootstrap interpreter behind immediately. In particular,
# never use Apple's /usr/bin/python3 (currently 3.9) for repository code.
user_bin_dir=$HOME/.local/bin
mkdir -p "$user_bin_dir"
UV_PYTHON_BIN_DIR=$user_bin_dir
UV_PYTHON_PREFERENCE=only-managed
export UV_PYTHON_BIN_DIR
export UV_PYTHON_PREFERENCE
"$uv_bin" python install 3.14
python314_bin=$user_bin_dir/python3.14
if ! "$python314_bin" -c 'import sys; raise SystemExit(sys.version_info[:2] != (3, 14))'; then
	die "uv did not provide Python 3.14"
fi

for python_alias in python python3; do
	if [ ! -e "$user_bin_dir/$python_alias" ] &&
		[ ! -L "$user_bin_dir/$python_alias" ]; then
		ln -s python3.14 "$user_bin_dir/$python_alias"
	fi
done

UV_TOOL_BIN_DIR=$user_bin_dir
export UV_TOOL_BIN_DIR
"$uv_bin" tool install \
	--python 3.14 \
	--force \
	--compile-bytecode \
	--with-executables-from ansible-core \
	"$ansible_tool_spec"
"$uv_bin" tool install \
	--python 3.14 \
	--force \
	--compile-bytecode \
	"$ansible_lint_tool_spec"

PATH=$user_bin_dir:$homebrew_path
export PATH
ansible_galaxy_bin=$user_bin_dir/ansible-galaxy
ansible_playbook_bin=$user_bin_dir/ansible-playbook
if [ ! -x "$ansible_galaxy_bin" ] || [ ! -x "$ansible_playbook_bin" ]; then
	die "uv did not create Ansible commands under $user_bin_dir"
fi
if ! "$ansible_playbook_bin" --version |
	grep 'python version = 3\.14\.' >/dev/null; then
	die "uv Ansible is not running on Python 3.14"
fi

if [ "$kernel_name" = Darwin ] &&
	"$homebrew_bin" list --cask karabiner-elements >/dev/null 2>&1; then
	ensure_sudo_available "removing Karabiner-Elements"
	"$homebrew_bin" uninstall --cask --force karabiner-elements
fi

cd "$repo_dir"
install_ansible_collections "$ansible_galaxy_bin"

set -- "$site_playbook" "$@"
if needs_ansible_become_prompt "$@"; then
	set -- --ask-become-pass "$@"
elif ! has_ansible_become_prompt_arg "$@" &&
	[ -z "${ANSIBLE_BECOME_ASK_PASS-}" ]; then
	ANSIBLE_BECOME_ASK_PASS=false
	export ANSIBLE_BECOME_ASK_PASS
fi

cleanup
trap - 0 HUP INT TERM
exec "$ansible_playbook_bin" "$@"
