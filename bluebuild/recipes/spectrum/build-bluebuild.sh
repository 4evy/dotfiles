#!/usr/bin/env bash
# shellcheck shell=bash

set -euo pipefail

source_lock=${SOURCE_LOCK:?SOURCE_LOCK must point to the generated source lock}
source_directory=${SOURCE_DIRECTORY:-/build/bluebuild-source}
prefix=${PREFIX:-/out/usr}

source_repository=$(jq -er '.pins["bluebuild-cli"] | "https://github.com/" + .owner + "/" + .repo + ".git"' "$source_lock")
source_revision=$(jq -er '.pins["bluebuild-cli"].rev' "$source_lock")
install -d -m 0755 "$source_directory"
git init -q "$source_directory"
git -C "$source_directory" remote add origin "$source_repository"
git -C "$source_directory" fetch --depth=1 origin "$source_revision"
git -C "$source_directory" checkout --detach --quiet FETCH_HEAD

cargo build \
	--manifest-path "$source_directory/Cargo.toml" \
	--locked \
	--release \
	--features recipe-v2 \
	--bin bluebuild
install -D -m 0755 "$source_directory/target/release/bluebuild" "$prefix/bin/bluebuild"
"$prefix/bin/bluebuild" --version
"$prefix/bin/bluebuild" recipe --help >/dev/null
