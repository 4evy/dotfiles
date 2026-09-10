#!/usr/bin/env bash
# shellcheck shell=bash

set -euo pipefail

source_lock=${SOURCE_LOCK:?SOURCE_LOCK must point to the generated source lock}
source_pin=${SOURCE_PIN:-kanata-homebrew}
patches_lock=${PATCHES_LOCK:?PATCHES_LOCK must point to the shared repository lock}
patch_stack=${PATCH_STACK:-kanata}
prefix=${PREFIX:-/out/usr}
source_directory=${SOURCE_DIRECTORY:-/build/kanata-source}

source_repository=$(jq -er --arg pin "$source_pin" '"https://github.com/" + .pins[$pin].owner + "/" + .pins[$pin].repo + ".git"' "$source_lock")
source_revision=$(jq -er --arg pin "$source_pin" '.pins[$pin].rev' "$source_lock")
install -d -m 0755 "$source_directory"
git init -q "$source_directory"
git -C "$source_directory" remote add origin "$source_repository"
git -C "$source_directory" fetch --depth=1 origin "$source_revision"
git -C "$source_directory" checkout --detach --quiet FETCH_HEAD

patches_repository=$(jq -er '.repository' "$patches_lock")
patches_revision=$(jq -er '.revision' "$patches_lock")
git init -q /build/patches
git -C /build/patches remote add origin "$patches_repository"
git -C /build/patches fetch --depth=1 origin "$patches_revision"
git -C /build/patches checkout --detach --quiet FETCH_HEAD
patches="/build/patches/stacks/$patch_stack/patches"
test -s "$patches/series"

while IFS= read -r patch_name || [[ -n $patch_name ]]; do
	[[ -n $patch_name ]] || continue
	git -C "$source_directory" apply "$patches/$patch_name"
done <"$patches/series"

cargo build \
	--manifest-path "$source_directory/Cargo.toml" \
	--locked \
	--release \
	--features cmd \
	--bin kanata
install -D -m 0755 "$source_directory/target/release/kanata" "$prefix/bin/kanata"
"$prefix/bin/kanata" --version
