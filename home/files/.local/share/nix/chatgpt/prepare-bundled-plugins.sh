#!/usr/bin/env bash
# shellcheck shell=bash

# ChatGPT modifies copied plugin manifests, so its source must be writable
if [[ -z ${CODEX_ELECTRON_BUNDLED_PLUGINS_RESOURCES_PATH:-} ]]; then
	chatgpt_resources="${XDG_CACHE_HOME:-$HOME/.cache}/chatgpt/bundled-plugins/@package@"
	if [[ ! -d $chatgpt_resources ]]; then
		@coreutils@/mkdir -p "${chatgpt_resources%/*}"
		chatgpt_staging=$(@coreutils@/mktemp -d "$chatgpt_resources.XXXXXX")
		if ! @coreutils@/cp -R --reflink=auto --no-preserve=mode \
			@resources@/plugins @resources@/plugin-signatures "$chatgpt_staging/"; then
			@coreutils@/rm -rf "$chatgpt_staging"
			return 1
		fi
		if ! @coreutils@/mv -T "$chatgpt_staging" "$chatgpt_resources"; then
			@coreutils@/rm -rf "$chatgpt_staging"
			[[ -d $chatgpt_resources ]] || return 1
		fi
	fi
	export CODEX_ELECTRON_BUNDLED_PLUGINS_RESOURCES_PATH="$chatgpt_resources"
	unset chatgpt_resources chatgpt_staging
fi
