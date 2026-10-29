#!/bin/sh
set -eu

# Preserve the installer no-op on NixOS without installing unused dependencies
fingerprint=false
for argument in "$@"; do
	if [ "$argument" = --fingerprint ]; then fingerprint=true; fi
done
if [ -e /etc/NIXOS ] && [ "$fingerprint" = false ]; then exit 0; fi

# Bootstrap the runtime before TypeScript imports Effect or shared root helpers
package_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH='' cd -- "$package_root/../.." && pwd -P)
cd "$repo_root"
bun_executable=${BUN_EXE:-bun}
"$bun_executable" install --frozen-lockfile --ignore-scripts \
	--filter @dotfiles/workstation >&2
exec "$bun_executable" "$package_root/install.ts" "$@"
