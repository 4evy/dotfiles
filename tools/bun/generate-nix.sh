#!/usr/bin/env bash
set -euo pipefail

output=${1:-bun.nix}
bun2nix=(nix run .#bun2nix --)
formatter=(nix fmt --)
if [[ -n ${BUN_NIX_BUN2NIX:-} ]]; then
	bun2nix=("$BUN_NIX_BUN2NIX")
fi
if [[ -n ${BUN_NIX_NIXFMT:-} ]]; then
	formatter=("$BUN_NIX_NIXFMT")
fi

# Local dependencies resolve beside the generated bun.nix
"${bun2nix[@]}" --lock-file bun.lock --copy-prefix ./ --output-file "$output"
# Normalize the generator's unconditional fetcher arguments
deadnix --edit --quiet "$output"
"${formatter[@]}" "$output"
