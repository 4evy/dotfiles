#!/usr/bin/env bash
_ublue_uutils_prefix="${HOMEBREW_PREFIX:-/home/linuxbrew/.linuxbrew}"
if [[ -d "${_ublue_uutils_prefix}/opt/uutils-coreutils/libexec/uubin" && $- == *i* ]]; then
	for _ublue_uutils_path in \
		"${_ublue_uutils_prefix}/opt/uutils-coreutils/libexec/uubin" \
		"${_ublue_uutils_prefix}/opt/uutils-diffutils/libexec/uubin" \
		"${_ublue_uutils_prefix}/opt/uutils-findutils/libexec/uubin"; do
		case ":$PATH:" in
			*":${_ublue_uutils_path}:"*) ;;
			*) PATH="${PATH}:${_ublue_uutils_path}" ;;
		esac
	done
	unset _ublue_uutils_path
	export PATH
	# Use GNU stty for atuin state restore; uutils stty does not round-trip it.
	alias stty='/usr/bin/stty'
fi
unset _ublue_uutils_prefix
