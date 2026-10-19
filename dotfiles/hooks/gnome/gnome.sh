#!/bin/sh
if [ "$(uname -s)" = Linux ]; then
	set -eu
	command="gnome-catppuccin-custom-accent"
	if [ -x "$HJEM_HOME_DIR/.local/bin/$command" ]; then
		"$HJEM_HOME_DIR/.local/bin/$command"
	elif command -v "$command" >/dev/null 2>&1; then
		"$command"
	else
		printf "%s\n" "$command skipped: command not found"
	fi
	if command -v systemctl >/dev/null 2>&1; then
		systemctl --user daemon-reload >/dev/null 2>&1 || true
		systemctl --user enable --now gnome-catppuccin-custom-accent.service >/dev/null 2>&1 || true
	fi
fi
