#!/usr/bin/bash
# shellcheck shell=bash

set -euo pipefail

: "${SOURCE_LOCK:?}"
: "${SOURCE_PIN:?}"
: "${ZIG_PIN:?}"
: "${PATCHES_LOCK:?}"
: "${PATCH_STACK:?}"
: "${PREFIX:?}"
: "${VERSION_PREFIX:?}"
: "${ARTIFACT:?}"
: "${BUILD_ARGUMENTS:?}"

read -r -a build_arguments <<<"$BUILD_ARGUMENTS"
source_repository=$(jq -er --arg pin "$SOURCE_PIN" '"https://github.com/" + .pins[$pin].owner + "/" + .pins[$pin].repo + ".git"' "$SOURCE_LOCK")
revision=$(jq -er --arg pin "$SOURCE_PIN" '.pins[$pin].rev' "$SOURCE_LOCK")
patches_repository=$(jq -er '.repository' "$PATCHES_LOCK")
patches_revision=$(jq -er '.revision' "$PATCHES_LOCK")

mkdir -p /build/source /build/zig "$PREFIX"
python3.14 /src/download_source.py "$SOURCE_LOCK" "$ZIG_PIN" /build/zig.tar.xz
tar -xJf /build/zig.tar.xz --strip-components=1 -C /build/zig

git init -q /build/source
git -C /build/source remote add origin "$source_repository"
git -C /build/source fetch --depth=1 origin "$revision"
git -C /build/source checkout --detach --quiet FETCH_HEAD

git init -q /build/patches
git -C /build/patches remote add origin "$patches_repository"
git -C /build/patches fetch --depth=1 origin "$patches_revision"
git -C /build/patches checkout --detach --quiet FETCH_HEAD
patches="/build/patches/stacks/$PATCH_STACK/patches"
test -s "$patches/series"

while IFS= read -r patch_name || [[ -n $patch_name ]]; do
	[[ -n $patch_name ]] || continue
	git -C /build/source apply "$patches/$patch_name"
done <"$patches/series"

version="$VERSION_PREFIX.${revision:0:7}"
(
	cd /build/source
	build_status=0
	for attempt in 1 2 3; do
		if PATH="/build/zig:$PATH" ZIG_GLOBAL_CACHE_DIR=/build/zig-cache \
			/build/zig/zig build \
			-p "$PREFIX" \
			"${build_arguments[@]}" \
			"-Dversion-string=$version"; then
			build_status=0
			break
		else
			build_status=$?
		fi

		if ((attempt < 3)); then
			delay=$((attempt * 5))
			printf 'Ghostty build failed (attempt %d/3); retrying in %d seconds\n' \
				"$attempt" "$delay" >&2
			sleep "$delay"
		fi
	done
	exit "$build_status"
)

test -x "$ARTIFACT"
find "$PREFIX" -type f -name '*.la' -delete
