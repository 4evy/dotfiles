#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if command -v bun >/dev/null 2>&1; then
	exec bun "$script_dir/setup.ts" "$@"
fi

case "$(uname -s)/$(uname -m)" in
	Darwin/arm64)
		archive=bun-darwin-aarch64
		expected=80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403
		;;
	Linux/x86_64)
		archive=bun-linux-x64-baseline
		expected=1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b
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
	"https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/$archive.zip" \
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
"$temporary/$archive/bun" "$script_dir/setup.ts" "$@"
