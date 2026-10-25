#!/bin/sh
set -eu
command="sync-equicord-settings"
if [ -x "$HJEM_HOME_DIR/.local/bin/$command" ]; then
	"$HJEM_HOME_DIR/.local/bin/$command"
elif command -v "$command" >/dev/null 2>&1; then
	"$command"
else
	printf "%s\n" "$command skipped: command not found"
fi
