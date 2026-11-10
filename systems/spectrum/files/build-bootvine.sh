#!/usr/bin/env bash
# shellcheck shell=bash

set -euo pipefail

source_lock=${SOURCE_LOCK:?SOURCE_LOCK must point to the generated source lock}
source_directory=/build/bootvine-source
source_repository=$(jq -er '.pins.bootvine.url' "$source_lock")
source_revision=$(jq -er '.pins.bootvine.rev' "$source_lock")

install -d -m 0755 "$source_directory"
git init -q "$source_directory"
git -C "$source_directory" remote add origin "$source_repository"
git -C "$source_directory" fetch --depth=1 origin "$source_revision"
git -C "$source_directory" checkout --detach --quiet FETCH_HEAD

cargo build \
	--manifest-path "$source_directory/Cargo.toml" \
	--locked \
	--release \
	--package bootvine \
	--bin bootvine

# Keep upstream's units, resume drop-in and dracut assets together
"$source_directory/target/release/bootvine" install --destdir /out --initrd dracut
install -D -m 0644 "$source_directory/LICENSE" /out/usr/share/licenses/bootvine/LICENSE
