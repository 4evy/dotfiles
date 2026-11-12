import '../common.just'
import 'system.just'

set working-directory := '../..'
set default-list
# Evaluate the system configuration before the flake's import-from-derivation
# checks, then build the repository lint and formatting checks.
[group('check')]
check: _eval-system
    nix flake check --keep-going --no-build
    nix build --keep-going --print-build-logs \
      .#checks.{{ nix_system }}.pre-commit .#checks.{{ nix_system }}.treefmt

_eval-system:
    nix eval --raw .#nixosConfigurations.nixos.config.system.build.toplevel.drvPath >/dev/null

# Archive only realized build outputs, including intermediate Cargo artifacts
# Public substitutes retain their signatures and stay in their upstream caches
[group('check')]
cache:
    cache="$RUNNER_TEMP/nix-build-cache"
    next=$(mktemp -d "$RUNNER_TEMP/nix-build-cache.XXXXXX")
    trap 'rm -rf "$next"' EXIT
    nix path-info --all --json --json-format 1 >"$RUNNER_TEMP/nix-build-paths.json"
    jq -r 'to_entries[] | select(.value.deriver != null and (.value.signatures | length) == 0) | .key' \
      "$RUNNER_TEMP/nix-build-paths.json" | \
      nix copy --to "file://$next?compression=zstd" --stdin
    # Nix requires complete references while exporting. Drop signed paths only
    # after the copy, then retain blobs referenced by the remaining narinfos
    jq -r 'to_entries[] | select((.value.signatures | length) > 0) | .key | split("/")[-1][:32]' \
      "$RUNNER_TEMP/nix-build-paths.json" | \
      while IFS= read -r hash; do rm -f "$next/$hash.narinfo"; done
    declare -A retained=()
    for info in "$next"/*.narinfo; do
      [[ -f "$info" ]] || continue
      while read -r field value; do
        if [[ "$field" == URL: ]]; then retained["$value"]=1; fi
      done <"$info"
    done
    for nar in "$next"/nar/*; do
      [[ -f "$nar" ]] || continue
      [[ -n ${retained["nar/${nar##*/}"]+present} ]] || rm "$nar"
    done
    # Unused outputs from the restored archive never entered this store
    rm -rf "$cache"
    mv "$next" "$cache"
