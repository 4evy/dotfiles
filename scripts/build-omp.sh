#!/bin/sh
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
patches=$repo/packages/omp/patches
bun=$(command -v bun)
check_patches=false
if [ "${1-}" = --check-patches ] && [ "$#" -eq 2 ]; then
	check_patches=true
	version=$2
elif [ "$#" -eq 0 ]; then
	omp_bin=$("$bun" pm bin --global)
	installed=$("$bun" -e 'import { realpathSync } from "node:fs"; import { dirname } from "node:path"; console.log(dirname(dirname(realpathSync(process.argv[1]))))' "$omp_bin/omp")
	global_modules=$(dirname -- "$(dirname -- "$installed")")
	version=$("$bun" -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$installed/package.json")
else
	printf '%s\n' "Usage: build-omp.sh [--check-patches VERSION]" >&2
	exit 1
fi
case "$version" in
	'' | *[!0-9.a-zA-Z-]*)
		printf '%s\n' "omp: invalid release version: $version" >&2
		exit 1
		;;
esac

if "$check_patches"; then
	staging=$(mktemp -d "${TMPDIR:-/tmp}/omp-patch-check.XXXXXX")
else
	# Include build inputs so subsequent launches reuse exactly the same bundle
	key=$({
		printf '%s\n' "$version" "$installed" "$("$bun" --version)"
		cat "$0" "$patches"/*.patch
	} | shasum -a 256 | cut -d ' ' -f 1)
	cache=${XDG_CACHE_HOME:-$HOME/.cache}/dotfiles/omp/$key
	if [ -f "$cache/runtime/dist/cli.js" ]; then
		printf '%s\n' "$cache/runtime/dist/cli.js"
		exit 0
	fi

	mkdir -p "$(dirname -- "$cache")"
	staging=$(mktemp -d "${cache}.XXXXXX")
fi
trap '[ -z "$staging" ] || rm -rf "$staging"' EXIT HUP INT TERM
printf '%s\n' "omp: applying dotfiles patches to $version" >&2
curl --fail --location --silent --show-error \
	"https://codeload.github.com/can1357/oh-my-pi/tar.gz/refs/tags/v$version" \
	--output "$staging/source.tar.gz"
mkdir "$staging/source"
tar -xzf "$staging/source.tar.gz" -C "$staging/source" --strip-components=1
(
	cd "$staging/source"
	for file in "$patches"/*.patch; do
		if ! patch -p1 -f -F 0 <"$file"; then
			printf '%s\n' "omp: cannot safely apply $(basename -- "$file") to $version; update aborted" >&2
			exit 1
		fi
	done
) >&2
if "$check_patches"; then
	printf '%s\n' "omp: all patches apply cleanly to $version" >&2
	exit 0
fi
(
	cd "$staging/source"
	"$bun" install --frozen-lockfile
	# Reuse the matching release addon instead of compiling Rust for this UI build
	for native in "$global_modules"/@oh-my-pi/pi-natives-*/*.node; do
		[ -f "$native" ] || continue
		cp "$native" packages/natives/native/
	done
	"$bun" run gen:bundle
) >&2

# Extensions can fall back to filesystem subpaths absent from the bundle's
# virtual module registry, so their sources must match the patched CLI
cp -R "$installed" "$staging/runtime"
rm -rf "$staging/runtime/src"
cp -R "$staging/source/packages/coding-agent/src" "$staging/runtime/src"
cp -R "$staging/source/packages/coding-agent/dist/." "$staging/runtime/dist/"

# Isolate patched workspace dependencies without modifying Bun's global install
modules=$staging/runtime/node_modules
mkdir -p "$modules/@oh-my-pi"
for dependency in "$global_modules"/*; do
	[ "$(basename -- "$dependency")" = @oh-my-pi ] && continue
	ln -s "$dependency" "$modules/"
done
for dependency in "$global_modules"/@oh-my-pi/*; do
	case "$(basename -- "$dependency")" in
		pi-coding-agent | pi-tui) continue ;;
	esac
	ln -s "$dependency" "$modules/@oh-my-pi/"
done
ln -s ../.. "$modules/@oh-my-pi/pi-coding-agent"
cp -R "$global_modules/@oh-my-pi/pi-tui" "$modules/@oh-my-pi/pi-tui"
rm -rf "$modules/@oh-my-pi/pi-tui/src"
cp -R "$staging/source/packages/tui/src" "$modules/@oh-my-pi/pi-tui/src"
rm -rf "$staging/source" "$staging/source.tar.gz"
# Another launcher may have finished the same build while this one ran
if ln -sn "$staging" "$cache" 2>/dev/null; then
	staging=''
fi
printf '%s\n' "$cache/runtime/dist/cli.js"
