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
python3 - "$SOURCE_LOCK" "$ZIG_PIN" <<'PYTHON'
import json
import sys
from pathlib import Path

sys.path.insert(0, "/src")
from source_lock import download_file

lock, name = sys.argv[1:]
pin = json.loads(Path(lock).read_text())["pins"][name]
download_file(pin, Path("/build/zig.tar.xz"))
PYTHON
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

while IFS= read -r patch_name; do
	git -C /build/source apply "$patches/$patch_name"
done <"$patches/series"

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
