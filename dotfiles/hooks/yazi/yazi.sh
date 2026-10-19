#!/bin/sh
set -eu
if ! command -v ya >/dev/null 2>&1; then
	printf '%s\n' 'Yazi plugin install skipped: ya not found'
	exit 0
fi
export YAZI_CONFIG_HOME="${XDG_CONFIG_HOME:-$HJEM_HOME_DIR/.config}/yazi"
if [ ! -f "$YAZI_CONFIG_HOME/package.toml" ]; then
	printf 'Yazi plugin install skipped: %s/package.toml not found\n' "$YAZI_CONFIG_HOME"
	exit 0
fi
exec ya pkg install --discard
