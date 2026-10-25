#!/bin/sh
set -eu

home=${HJEM_HOME_DIR:-$HOME}
settings="$home/.super.engineering/settings.json"
config="$home/.config/super-engineering/settings.json"

# Native settings also contain mutable project and workspace state
# Merge managed JSON preferences instead of replacing the app-owned file
# Apply with the app closed to avoid its stale in-memory saves
[ -f "$settings" ] || exit 0

temporary=$(mktemp -d "$settings.dotfiles.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
cp -p "$settings" "$temporary/original"
cp -p "$settings" "$temporary/updated"
jq -s '.[0] * .[1]' "$temporary/original" "$config" >"$temporary/updated"

# Avoid rewriting app-serialized floats or unrelated settings on every apply
if jq -e -s '.[0] == .[1]' "$temporary/original" "$temporary/updated" >/dev/null; then
	exit 0
fi

# Refuse to overwrite settings saved by the running app during the merge
if ! cmp -s "$settings" "$temporary/original"; then
	printf '%s\n' 'super.engineering settings changed during apply, run just apply again' >&2
	exit 1
fi
mv "$temporary/updated" "$settings"
