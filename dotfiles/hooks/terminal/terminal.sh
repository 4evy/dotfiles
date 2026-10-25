#!/bin/sh
set -eu
command="terminal-catppuccin-custom"
if [ -x "$HJEM_HOME_DIR/.local/bin/$command" ]; then
	"$command"
elif command -v "$command" >/dev/null 2>&1; then
	"$command"
else
	printf "%s\n" "$command skipped: command not found"
fi
