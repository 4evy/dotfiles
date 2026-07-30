#!/usr/bin/bash
# shellcheck shell=bash

set -euo pipefail

: "${SOURCE_LOCK:?}"
: "${SOURCE_PIN:?}"
: "${REVISION_PIN:?}"
: "${ZIG_PIN:?}"
: "${PATCHES:?}"
: "${PREFIX:?}"
: "${VERSION_PREFIX:?}"
: "${ARTIFACT:?}"
: "${BUILD_ARGUMENTS:?}"

mapfile -t build_arguments <<<"$BUILD_ARGUMENTS"
source_url=$(jq -er --arg pin "$SOURCE_PIN" '.pins[$pin].url' "$SOURCE_LOCK")
source_hash=$(jq -er --arg pin "$SOURCE_PIN" '.pins[$pin].hash' "$SOURCE_LOCK")
zig_url=$(jq -er --arg pin "$ZIG_PIN" '.pins[$pin].url' "$SOURCE_LOCK")
zig_hash=$(jq -er --arg pin "$ZIG_PIN" '.pins[$pin].hash' "$SOURCE_LOCK")
revision=$(jq -er --arg pin "$REVISION_PIN" '.pins[$pin].revision' "$SOURCE_LOCK")

verify_sri() {
	local path=$1
	local expected=$2
	local actual
	actual="sha256-$(openssl dgst -sha256 -binary "$path" | openssl base64 -A)"
	if [[ $actual != "$expected" ]]; then
		printf 'checksum mismatch for %s\nexpected: %s\nactual:   %s\n' \
			"$path" "$expected" "$actual" >&2
		return 1
	fi
}

mkdir -p /build/source /build/zig "$PREFIX"
curl -fLsS --retry 5 "$source_url" -o /build/ghostty.tar.gz
curl -fLsS --retry 5 "$zig_url" -o /build/zig.tar.xz
verify_sri /build/ghostty.tar.gz "$source_hash"
verify_sri /build/zig.tar.xz "$zig_hash"

tar -xzf /build/ghostty.tar.gz --strip-components=1 -C /build/source
tar -xJf /build/zig.tar.xz --strip-components=1 -C /build/zig

while IFS= read -r patch_name; do
	[[ -n $patch_name ]] || continue
	git -C /build/source apply --check "$PATCHES/$patch_name"
	git -C /build/source apply "$PATCHES/$patch_name"
done <"$PATCHES/series"

version="$VERSION_PREFIX.${revision:0:7}"
(
	cd /build/source
	PATH="/build/zig:$PATH" ZIG_GLOBAL_CACHE_DIR=/build/zig-cache \
		/build/zig/zig build \
		-p "$PREFIX" \
		"${build_arguments[@]}" \
		"-Dversion-string=$version"
)

test -x "$ARTIFACT"
find "$PREFIX" -type f -name '*.la' -delete
