#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

case "$#" in
	0) ;;
	1)
		if [[ $1 != --check ]]; then
			printf '%s\n' "usage: update-chatgpt-nix [--check]" >&2
			exit 2
		fi
		;;
	*)
		printf '%s\n' "usage: update-chatgpt-nix [--check]" >&2
		exit 2
		;;
esac

readonly data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
readonly package_dir="$data_home/nix/chatgpt"
readonly package_target="$package_dir/package.nix"
readonly repository="${DOTFILES_REPOSITORY:-$HOME/dotfiles}"
readonly package_source="$repository/dotfiles/home/.local/share/nix/chatgpt/package.nix"

if [[ ! -f $package_dir/flake.nix || ! -f $package_target ]]; then
	printf '%s\n' "the ChatGPT Nix package is unavailable" >&2
	exit 1
fi

if (($#)); then
	CHATGPT_PACKAGE_FILE="$package_target" \
		nix run "path:$package_dir#update-chatgpt" -- --check
	exit
fi

if [[ ! -f $repository/Justfile || ! -f $package_source ]]; then
	printf '%s\n' "the dotfiles repository is unavailable at $repository" >&2
	exit 1
fi

CHATGPT_PACKAGE_FILE="$package_source" \
	nix run "path:$package_dir#update-chatgpt"
just --justfile "$repository/Justfile" apply

if [[ ! -e /etc/NIXOS ]]; then
	just --justfile "$repository/Justfile" hjem
else
	# A failed profile query must abort instead of selecting installation
	chatgpt_installed=$(nix profile list --json | jq -r '.elements | has("chatgpt")')
	if [[ $chatgpt_installed == true ]]; then
		nix profile upgrade chatgpt
	else
		nix profile install "path:$package_dir#chatgpt"
	fi
fi
