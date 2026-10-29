# shellcheck shell=bash
#           ⣀⡤⡤⣄⡀                                                       ⢀⣀⣤
#         ⢠⢞⠣⠑⢌⠢⠙⢦                        ⡄                            ⢀⣷⡾⣽
#        ⢀⣏⠢⠐⢈⣢⠐⢈⠪⣇                     ⠤⣞⢙⡦⠄                        ⣀ ⠸⣿⠟⠋⣹⠶
#        ⢸⢢⡕⠙⢯⣨⠟⠣⣕⢼                      ⠈⡏                       ⢠⠞⠉⠉⠉⠙⠁ ⢼⠁
#        ⣸⣿⡼⠁   ⠹⣼⢿⡀                      ⡇                       ⡏⡞      ⠈⠒⢤
#       ⣴⣛⣿⢣    ⢠⢻⣟⣷⡄                     ⡇                       ⡇⡇        ⢸
#       ⢉⣀⣘⣿⣷⡀ ⣰⣫⣟⣀⣈⠁             ⣀⣀⣀⣀⣀⣀⣀⣀⣇⣀⣀⣀⣀⣀⣀⣀⡀               ⢳⣿⡀       ⡼
#       ⢯⣸⣀⣇⣏⡿⠺⣏⣇⣇⣸⣨⠇             ⡇               ⡇                ⠻⣍     ⣀⠜⠁
#          ⠁     ⠁          ⢀⠔⠒⠒⠒⠒⡇    ⣠⢴⠺⡟⡲⢤⡀    ⡗⠒⠒⠒⠒⢄            ⠈⠉⠉⠉⠉⠉⠁
#                  ⣠⢤⡀    ⢀⠔⠁     ⡇   ⡸⡹⣄⣦⣧⣔⡼⠽⡀   ⡇     ⠑⢄     ⣠⢤⡀
#                  ⠳⠼⠋⠉⠉⠉⠉⠁  ⢀⣀⣀⣀⣀⡇  ⢠⣣⣐⡏⠄⢂⠡⢗⣈⣧   ⣇⣀⣀⣀⣀   ⠉⠉⠉⠉⠉⠻⠴⠃
#                          ⢀⠔⠁    ⡇  ⠈⣆⠡⣗⡈⠄⣂⡧⠐⡎   ⡇    ⠑⢄
#                  ⣞⢹⡦⠤⠤⠤⠤⠔⠁      ⡇   ⠸⣞⠡⠙⡏⠅⢛⡽    ⡇      ⠑⠤⠤⠤⠤⠤⣾⢙⡆
#                  ⠈⠉       ⢀⠔⠒⠒⠒⠒⡇    ⠈⠙⠳⠷⠚⠉     ⡗⠒⠒⠒⠒⢄       ⠈⠉
#                  ⣠⢤⡀    ⢀⠔⠁     ⣇⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⡇     ⠑⢄     ⣠⢤⡀
#                  ⠳⠼⠋⠉⠉⠉⠉⠁                               ⠉⠉⠉⠉⠉⠻⠴⠃
#
#
#
#
#                                  ⢀⣀⣀⣀⣀⣀⡀
#                                  ⢸⢀⣀⣀⣀⣀⣳⣄⣀⣀⣀⣀⣀⣀⣀
#                                  ⢸⠘⢠⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠧⢼⠤⣤
#                                  ⢸⢠⠇           ⢸⢀⠇
#                                  ⢸⡞ ⢀⣀⣀⣀⣀⣀⣀⣀⣀⡀ ⢸⡼
#                                  ⢸⣥⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣼⠃

# Environment shared by Bash and Zsh.
#
# This file is sourced from .bashenv and .zshenv, including non-interactive
# shells. It must stay quiet, avoid terminal-only work, and preserve a caller's
# deliberately customized environment after the first load in each shell.

if [[ -n "${_dotfiles_environment_loaded:-}" ]]; then
	return 0
fi

# Command substitutions run in subshells, so detect the platform only once
_dotfiles_os="$(uname -s)"

# 01 / package-manager environment

# Determinate Nix's system hooks run at different points in Bash and Zsh.
# Source the idempotent upstream hook here so every managed shell receives the
# same Nix metadata, then let the PATH builder below apply our precedence.
if [[ ! -e /etc/NIXOS ]]; then
	if [[ -r /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]]; then
		# shellcheck source=/dev/null
		source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
	fi
fi

# Homebrew metadata mirrors `brew shellenv` without spawning Homebrew during
# every shell startup.

_dotfiles_homebrew_prefix=
if [[ "$_dotfiles_os" == Linux ]]; then
	if [[ ! -e /etc/NIXOS ]]; then
		if [[ -x /home/linuxbrew/.linuxbrew/bin/brew ]]; then
			_dotfiles_homebrew_prefix=/home/linuxbrew/.linuxbrew
		elif [[ -x "$HOME/.linuxbrew/bin/brew" ]]; then
			_dotfiles_homebrew_prefix="$HOME/.linuxbrew"
		fi
	fi
elif [[ "$_dotfiles_os" == Darwin ]]; then
	if [[ -x /opt/homebrew/bin/brew ]]; then
		_dotfiles_homebrew_prefix=/opt/homebrew
	fi
fi

if [[ -n "$_dotfiles_homebrew_prefix" ]]; then
	export HOMEBREW_PREFIX="$_dotfiles_homebrew_prefix"
	export HOMEBREW_CELLAR="$HOMEBREW_PREFIX/Cellar"
	if [[ "$HOMEBREW_PREFIX" == /opt/homebrew ]]; then
		export HOMEBREW_REPOSITORY="$HOMEBREW_PREFIX"
	else
		export HOMEBREW_REPOSITORY="$HOMEBREW_PREFIX/Homebrew"
	fi
	[[ -z "${MANPATH-}" ]] || export MANPATH=":${MANPATH#:}"
	case ":${INFOPATH:-}:" in
		*":$HOMEBREW_PREFIX/share/info:"*) ;;
		*) export INFOPATH="$HOMEBREW_PREFIX/share/info:${INFOPATH:-}" ;;
	esac
fi
unset _dotfiles_homebrew_prefix

# Use the Brewfile-managed JDK as the default while preserving an explicitly
# selected JDK; its bin directory is added from JAVA_HOME below
if [[ -z "${JAVA_HOME:-}" ]]; then
	if [[ "$_dotfiles_os" == Darwin ]]; then
		_dotfiles_java_home="$(/usr/libexec/java_home 2>/dev/null || true)"
	else
		_dotfiles_java_home="${HOMEBREW_PREFIX:-}/opt/openjdk/libexec"
	fi
	if [[ -x "$_dotfiles_java_home/bin/java" ]]; then
		export JAVA_HOME="$_dotfiles_java_home"
	fi
	unset _dotfiles_java_home
fi

# Homebrew's Android command-line tools use this directory as the SDK root.
if [[ -z "${ANDROID_HOME:-}" && -n "${HOMEBREW_PREFIX:-}" ]]; then
	_dotfiles_android_home="$HOMEBREW_PREFIX/share/android-commandlinetools"
	if [[ -d "$_dotfiles_android_home" ]]; then
		export ANDROID_HOME="$_dotfiles_android_home"
	fi
	unset _dotfiles_android_home
fi

# 02 / PATH
# Build a unique preferred prefix, then append the inherited PATH in its
# original order. Empty entries are omitted so PATH never implies the current
# working directory.

_dotfiles_new_path=
_dotfiles_path_append_once() {
	local candidate
	for candidate; do
		[[ -n "$candidate" ]] || continue
		case ":${_dotfiles_new_path}:" in
			*":$candidate:"*) ;;
			*)
				_dotfiles_new_path="${_dotfiles_new_path:+$_dotfiles_new_path:}$candidate"
				;;
		esac
	done
}

if [[ "$_dotfiles_os" == Linux ]]; then
	if [[ -d /run/wrappers/bin ]]; then
		_dotfiles_path_append_once /run/wrappers/bin
	fi
fi
# Hjem-managed commands take precedence on every supported host
_dotfiles_path_append_once "$HOME/.local/bin"
if [[ ! -e /etc/NIXOS ]]; then
	if [[ "$_dotfiles_os" == Linux ]]; then
		_dotfiles_path_append_once "${XDG_STATE_HOME:-$HOME/.local/state}/hjem/standalone/current-profile/bin"
	fi
	_dotfiles_path_append_once "$HOME/.nix-profile/bin"
	if [[ "$_dotfiles_os" == Darwin ]]; then
		_dotfiles_path_append_once /run/current-system/sw/bin
	fi
	if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then
		_dotfiles_path_append_once "$JAVA_HOME/bin"
	fi
	if [[ -n "${HOMEBREW_PREFIX:-}" ]]; then
		# Hjem pre-renders the shared Homebrew inventory, never parse at startup
		if [[ "$_dotfiles_os" == Darwin ]]; then
			# shellcheck source=/dev/null
			source "$HOME/.config/shell/homebrew-path.sh"
		fi
		_dotfiles_path_append_once "$HOMEBREW_PREFIX/opt/rustup/bin"
		_dotfiles_path_append_once "$HOMEBREW_PREFIX/bin" "$HOMEBREW_PREFIX/sbin"
	fi
	_dotfiles_path_append_once \
		"$HOME/.bun/bin" \
		"$HOME/.bun/install/global/node_modules/.bin" \
		"$HOME/.cache/.bun/bin" \
		"$HOME/.npm/bin" \
		"$HOME/.cargo/bin" \
		"$HOME/.go/bin" \
		"$HOME/.yarn/bin"
	_dotfiles_path_append_once \
		"$HOME/.nix-profile/bin" \
		/nix/var/nix/profiles/default/bin
fi
if [[ "$_dotfiles_os" == Linux ]]; then
	_dotfiles_path_append_once /usr/local/bin /usr/bin /bin /usr/sbin /sbin
elif [[ "$_dotfiles_os" == Darwin ]]; then
	_dotfiles_path_append_once /usr/local/bin /usr/local/sbin
fi

_dotfiles_path_remainder="${PATH-}:"
while [[ "$_dotfiles_path_remainder" == *:* ]]; do
	_dotfiles_path_entry="${_dotfiles_path_remainder%%:*}"
	_dotfiles_path_remainder="${_dotfiles_path_remainder#*:}"
	_dotfiles_path_append_once "$_dotfiles_path_entry"
done

if [[ "$_dotfiles_os" == Darwin ]]; then
	# Expose Homebrew binutils commands that macOS lacks without replacing Apple's
	# linker and other native toolchain commands that appeared earlier in PATH.
	if [[ -n "${HOMEBREW_PREFIX:-}" ]]; then
		# shellcheck source=/dev/null
		source "$HOME/.config/shell/homebrew-path-tail.sh"
	fi
fi

PATH=$_dotfiles_new_path
export PATH
unset _dotfiles_new_path _dotfiles_path_entry _dotfiles_path_remainder
unset -f _dotfiles_path_append_once

if [[ "$_dotfiles_os" == Linux && ! -e /etc/NIXOS ]]; then
	# Nix ncurses omits host terminfo paths, including Ghostty's entry on Fedora
	# Keep caller overrides and the empty entry for compiled-in defaults
	for _dotfiles_terminfo in /usr/local/share/terminfo /usr/share/terminfo; do
		case ":${TERMINFO_DIRS:-}:" in
			*":$_dotfiles_terminfo:"*) ;;
			*) export TERMINFO_DIRS="${TERMINFO_DIRS-}:$_dotfiles_terminfo" ;;
		esac
	done
	unset _dotfiles_terminfo

	_dotfiles_hjem_share="${XDG_STATE_HOME:-$HOME/.local/state}/hjem/standalone/current-profile/share"
	case ":${XDG_DATA_DIRS:-}:" in
		*":$_dotfiles_hjem_share:"*) ;;
		*) export XDG_DATA_DIRS="$_dotfiles_hjem_share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" ;;
	esac
	unset _dotfiles_hjem_share
	_dotfiles_hjem_profile="${XDG_STATE_HOME:-$HOME/.local/state}/hjem/standalone/current-profile"
	case ":${MANPATH:-}:" in
		*":$_dotfiles_hjem_profile/share/man:"*) ;;
		*) export MANPATH="$_dotfiles_hjem_profile/share/man:${MANPATH:-}" ;;
	esac
	case ":${INFOPATH:-}:" in
		*":$_dotfiles_hjem_profile/share/info:"*) ;;
		*) export INFOPATH="$_dotfiles_hjem_profile/share/info:${INFOPATH:-}" ;;
	esac
	unset _dotfiles_hjem_profile
fi

# 03 / SSH agent
# Local shells use 1Password; remote sessions retain sshd's forwarded agent.

if [[ "$_dotfiles_os" == Darwin ]]; then
	_dotfiles_ssh_auth_sock="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
else
	_dotfiles_ssh_auth_sock="$HOME/.1password/agent.sock"
fi
if [[ -z "${SSH_CONNECTION:-}" ]]; then
	export SSH_AUTH_SOCK="$_dotfiles_ssh_auth_sock"
fi
if [[ -S "$_dotfiles_ssh_auth_sock" ]]; then
	export OP_BIOMETRIC_UNLOCK_ENABLED="${OP_BIOMETRIC_UNLOCK_ENABLED:-true}"
fi
unset _dotfiles_ssh_auth_sock

# 04 / shared tool defaults

export EDITOR="hx"
export VISUAL="hx"

if [[ "$_dotfiles_os" == Darwin ]]; then
	if command -v sops-age-key-1password >/dev/null 2>&1; then
		export SOPS_AGE_KEY_CMD="${SOPS_AGE_KEY_CMD:-sops-age-key-1password}"
		if [[ -n "${OPENCODE:-}${CODEX_THREAD_ID:-}" ]]; then
			export SOPS_AGE_KEY_CACHE="${SOPS_AGE_KEY_CACHE:-records}"
		fi
	fi
fi

export BASH_ENV="${BASH_ENV:-$HOME/.bashenv}"
export UV_PYTHON="${UV_PYTHON:-3.14}"
export UV_PYTHON_PREFERENCE="${UV_PYTHON_PREFERENCE:-only-managed}"
export RUMDL_CACHE_DIR="${RUMDL_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/rumdl}"
export GLAMOUR_STYLE="${GLAMOUR_STYLE:-$HOME/.config/glamour/styles/catppuccin-custom-dark.json}"

# Redirect project-local TypeScript CLI launchers through the managed compiler
_dotfiles_compiler_preload="$HOME/.local/lib/typescript/compiler.mts"
if [[ -f "$_dotfiles_compiler_preload" ]]; then
	case "${NODE_OPTIONS:-}" in
		*"$_dotfiles_compiler_preload"*) ;;
		*) export NODE_OPTIONS="--import=$_dotfiles_compiler_preload${NODE_OPTIONS:+ $NODE_OPTIONS}" ;;
	esac
	# Repair the quoted preload value inherited from the initial configuration
	_dotfiles_quoted_preload="--preload=\"$_dotfiles_compiler_preload\""
	export BUN_OPTIONS="${BUN_OPTIONS:-}"
	BUN_OPTIONS="${BUN_OPTIONS//"$_dotfiles_quoted_preload"/"--preload=$_dotfiles_compiler_preload"}"
	unset _dotfiles_quoted_preload
	case "${BUN_OPTIONS:-}" in
		*"$_dotfiles_compiler_preload"*) ;;
		*) export BUN_OPTIONS="--preload=$_dotfiles_compiler_preload${BUN_OPTIONS:+ $BUN_OPTIONS}" ;;
	esac
fi
unset _dotfiles_compiler_preload

# 05 / terminal capabilities

# Zed can inherit Ghostty's marker, but not its graphics support
if [[ "${TERM_PROGRAM:-}" == zed ]]; then
	unset GHOSTTY_RESOURCES_DIR
fi

# Tailscale SSH accepts LC_* variables but drops COLORTERM, so carry the
# client's color capability through LC_COLORTERM and restore it on arrival
if [[ -z "${COLORTERM:-}" && -n "${SSH_CONNECTION:-}" ]]; then
	case "${LC_COLORTERM:-}" in
		truecolor | 24bit) export COLORTERM="$LC_COLORTERM" ;;
	esac
fi
if [[ -n "${COLORTERM:-}" ]]; then
	export LC_COLORTERM="$COLORTERM"
else
	unset LC_COLORTERM
fi

_dotfiles_environment_loaded=1
unset DOTFILES_ENVIRONMENT_LOADED
unset _dotfiles_os
