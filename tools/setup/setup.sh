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
		expected=b5d6bc2e13caf14e57c89661e89efd073ff16165b41bfe43882616410609cd10
		;;
	Linux/x86_64)
		archive='bun-linux-x64-baseline'
		expected=dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463
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
readonly download_retries=3
readonly download_retry_delay_seconds=1
curl -fsSL --retry "$download_retries" --retry-delay "$download_retry_delay_seconds" \
	"https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/$archive.zip" \
	-o "$temporary/bun.zip"
if ! {
	if command -v sha256sum >/dev/null 2>&1; then
		printf '%s  %s\n' "$expected" "$temporary/bun.zip" | sha256sum -c -
	else
		printf '%s  %s\n' "$expected" "$temporary/bun.zip" | shasum -a 256 -c -
	fi
} >/dev/null; then
	echo 'Bun bootstrap checksum mismatch' >&2
	exit 1
fi
unzip -q "$temporary/bun.zip" -d "$temporary"
run_setup "$temporary/$archive/bun" "$@"
