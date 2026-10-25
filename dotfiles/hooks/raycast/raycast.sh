#!/bin/sh
set -eu

source='/Applications/Nix Apps/Raycast.app'
manager='/run/current-system/sw/bin/raycast-manager'
target='/Applications/Raycast.app'
config="$HOME/.config/raycast/config.json"
brew='/opt/homebrew/bin/brew'

fail() {
	printf 'raycast: %s\n' "$*" >&2
	exit 1
}

[ -d "$source" ] || fail "missing Nix app $source, run just darwin"
[ -x "$manager" ] || fail "missing Nix manager $manager, run just darwin"
[ -f "$config" ] || fail "missing configuration $config"

if [ -L "$target" ]; then
	[ "$(readlink "$target")" = "$source" ] || fail "$target points elsewhere"
elif [ -e "$target" ]; then
	if [ ! -x "$brew" ] || ! "$brew" list --cask raycast >/dev/null 2>&1; then
		fail "$target is not the Homebrew installation"
	fi
	"$brew" uninstall --cask raycast
	if [ -e "$target" ] || [ -L "$target" ]; then
		fail "Homebrew left $target in place"
	fi
	ln -s "$source" "$target"
else
	ln -s "$source" "$target"
fi

exec "$manager" configure "$config"
