#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(git rev-parse --show-toplevel)
output=${1:-Sources/theme-run-0.1.0.tar}
mkdir -p "$(dirname "$output")"
output=$(cd "$(dirname "$output")" && pwd)/$(basename "$output")
source_list=$(mktemp)
trap 'rm -f "$source_list"' EXIT

# Archive tracked module sources so file additions and removals need no manifest
# update. Nix packaging metadata is not part of the Homebrew build.
git -C "$repo_dir/packages/theme-run" ls-files -z -- . ':!package.nix' >"$source_list"
(
	cd "$repo_dir/packages/theme-run"
	COPYFILE_DISABLE=1 tar -cf "$output" --null -T "$source_list"
)
COPYFILE_DISABLE=1 tar -rf "$output" -C "$repo_dir" LICENSE
