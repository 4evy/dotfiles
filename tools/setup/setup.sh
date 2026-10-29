#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH='' cd -- "$script_dir/../.." && pwd)

# TypeScript setup uses the real Effect runtime, even on a fresh checkout
# Probe imports and pinned versions without running any setup program
run_setup() {
	bun=$1
	shift
	if ! "$bun" --no-install --cwd "$repo_dir" - <<-'JS' >/dev/null 2>&1
		import manifest from "./package.json";
		import "effect";
		import "@effect/platform-bun";
		for (const name of Object.keys(manifest.dependencies))
			require.resolve(name.startsWith("@dotfiles/") ? `${name}/package.json` : name);
		for (const name of ["effect", "@effect/platform-bun"]) {
			if (require(`${name}/package.json`).version !== manifest.dependencies[name])
				process.exit(1);
		}
	JS
	then
		"$bun" install --cwd "$repo_dir" --frozen-lockfile
	fi
	"$bun" "$script_dir/setup.ts" "$@"
}
if command -v bun >/dev/null 2>&1; then
	run_setup "$(command -v bun)" "$@"
	exit "$?"
fi

case "$(uname -s)/$(uname -m)" in
	Darwin/arm64)
		archive='bun-darwin-aarch64'
		expected=c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510
		;;
	Linux/x86_64)
		archive='bun-linux-x64-baseline'
		expected=e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76
		;;
	*)
		echo 'Setup requires Apple Silicon macOS or x86_64 Linux' >&2
		exit 1
		;;
esac

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
curl -fsSL --retry 3 --retry-delay 1 \
	"https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/$archive.zip" \
	-o "$temporary/bun.zip"
if command -v sha256sum >/dev/null 2>&1; then
	actual=$(sha256sum "$temporary/bun.zip" | awk '{print $1}')
else
	actual=$(shasum -a 256 "$temporary/bun.zip" | awk '{print $1}')
fi
if [ "$actual" != "$expected" ]; then
	echo 'Bun bootstrap checksum mismatch' >&2
	exit 1
fi
unzip -q "$temporary/bun.zip" -d "$temporary"
run_setup "$temporary/$archive/bun" "$@"
