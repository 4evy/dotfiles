#!/bin/sh
if [ "$(uname -s)" = Darwin ] || [ "$(uname -s)" = Linux ]; then
	set -eu

	if ! command -v nix >/dev/null 2>&1 || ! command -v gh >/dev/null 2>&1; then
		exit 0
	fi
	if ! token=$(gh auth token --hostname github.com 2>/dev/null); then
		exit 0
	fi

	# Keep credentials outside the source tree and Nix store
	umask 077
	config_dir="$HJEM_HOME_DIR/.config/nix"
	mkdir -p "$config_dir"
	temporary=$(mktemp "$config_dir/.github-access-tokens.XXXXXXXXXX")
	trap 'rm -f "$temporary"' EXIT
	# Preserve cancellation instead of returning success after cleanup
	trap 'exit 129' HUP
	trap 'exit 130' INT
	trap 'exit 143' TERM
	printf 'access-tokens = github.com=%s\n' "$token" >"$temporary"
	mv -f "$temporary" "$config_dir/github-access-tokens.conf"
fi
