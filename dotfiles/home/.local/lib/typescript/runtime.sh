#!/bin/sh
# GUI applications may not inherit the shell's compiler preloads
preload="@HOME@/.local/lib/typescript/compiler.mts"
case "${NODE_OPTIONS:-}" in
	*"$preload"*) ;;
	*) export NODE_OPTIONS="--import=$preload${NODE_OPTIONS:+ $NODE_OPTIONS}" ;;
esac
case "${BUN_OPTIONS:-}" in
	*"$preload"*) ;;
	*) export BUN_OPTIONS="--preload=$preload${BUN_OPTIONS:+ $BUN_OPTIONS}" ;;
esac

# Keep the managed PATH for children, skipping ourselves only during lookup
runtime=${0##*/}
remaining=${PATH:-}:
while [ -n "$remaining" ]; do
	directory=${remaining%%:*}
	remaining=${remaining#*:}
	candidate=${directory:-.}/$runtime
	if [ -f "$candidate" ] && [ -x "$candidate" ] && [ ! "$candidate" -ef "$0" ]; then
		exec "$candidate" "$@"
	fi
done
printf '%s\n' "$runtime: no underlying runtime found on PATH" >&2
exit 127
