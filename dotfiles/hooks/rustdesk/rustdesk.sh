#!/bin/sh
set -eu
bun "$HJEM_WORKING_TREE/scripts/setup/applications.ts" rustdesk
if [ "$(uname -s)" = Darwin ]; then
	domain="gui/$(id -u)"
	if ! /bin/launchctl print "$domain/com.carriez.RustDesk" >/dev/null 2>&1; then
		/bin/launchctl bootstrap "$domain" "$HJEM_HOME_DIR/Library/LaunchAgents/com.carriez.RustDesk.plist"
	fi
fi
