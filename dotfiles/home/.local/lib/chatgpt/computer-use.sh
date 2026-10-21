#!/usr/bin/env bash
set -euo pipefail

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

# MCP launches omit the desktop session environment, which X11 requires
while IFS= read -r entry; do
	case "$entry" in
		DISPLAY=* | XAUTHORITY=* | WAYLAND_DISPLAY=*) export "${entry?}" ;;
	esac
done < <(systemctl --user show-environment)

profile="${XDG_STATE_HOME:-$HOME/.local/state}/hjem/standalone/current-profile"
exec "$profile/lib/chatgpt/resources/cua_node/bin/node_repl" \
	--disable-sandbox "$@"
