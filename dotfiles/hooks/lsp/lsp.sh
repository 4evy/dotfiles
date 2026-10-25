#!/bin/sh
if [ "$(uname -s)" = Darwin ] || [ "$(uname -s)" = Linux ]; then
	# Install beside the LSP library so editor launchers resolve dependencies
	set -eu
	if ! command -v bun >/dev/null 2>&1; then
		printf '%s\n' 'LSP dependency install requires Bun on PATH' >&2
		exit 1
	fi
	bun install --cwd "$HJEM_HOME_DIR/.local/lib/typescript" --frozen-lockfile --production --ignore-scripts
	# The editor frontend uses our Rust SDK, not its bundled Go fallback
	for extension in "$HJEM_HOME_DIR"/.vscode/extensions/typescriptteam.native-preview-*; do
		[ -d "$extension" ] || continue
		rm -f "$extension/lib/tsc"
	done
fi
