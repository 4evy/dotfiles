#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

bun "${HJEM_WORKING_TREE:-@REPOSITORY@}/scripts/setup/ai/ai.ts" setup

# Use the activation home when invoked outside an interactive shell
readonly home_dir="${HJEM_HOME_DIR:-$HOME}"
readonly local_bin_dir="$home_dir/.local/bin"
readonly zsh_completion_dir="$home_dir/.cache/zsh/completions"
readonly bash_completion_dir="$home_dir/.local/share/bash-completion/completions"
mkdir -p "$local_bin_dir" "$zsh_completion_dir" "$bash_completion_dir"

if [[ $(uname -s) == Linux && -e /etc/NIXOS ]] && command -v nix >/dev/null 2>&1; then
	readonly chatgpt_package_dir="$home_dir/.local/share/nix/chatgpt"
	if [[ -f $chatgpt_package_dir/flake.nix ]]; then
		# A failed profile query must abort instead of selecting installation
		chatgpt_installed=$(nix profile list --json | jq -r '.elements | has("chatgpt")')
		if [[ $chatgpt_installed == true ]]; then
			nix profile upgrade chatgpt
		else
			nix profile install "path:$chatgpt_package_dir#chatgpt"
		fi
	fi
fi
