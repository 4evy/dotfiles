import '../common.just'

set working-directory := '../..'
set default-list
# Keep every independently locked Bun package's Nix cache in sync
[group('check')]
check:
    for package in packages/hyper-window-tiling packages/workstation; do
      generated_dir=$(mktemp -d)
      trap 'rm -rf "$generated_dir"' EXIT
      generated="$generated_dir/bun.nix"
      nix run .#bun2nix -- \
        --lock-file "$package/bun.lock" \
        --copy-prefix "./" \
        --output-file "$generated"
      deadnix --edit "$generated"
      nixfmt "$generated"
      if ! diff -u "$package/bun.nix" "$generated"; then
        printf '%s/bun.nix is stale, run `just bun nix update`.\n' "$package" >&2
        exit 1
      fi
      rm -rf "$generated_dir"
    done

# Regenerate all independent dependency caches from their locked graphs
[group('dev')]
update:
    for package in packages/hyper-window-tiling packages/workstation; do
      nix run .#bun2nix -- \
        --lock-file "$package/bun.lock" \
        --copy-prefix "./" \
        --output-file "$package/bun.nix"
      deadnix --edit "$package/bun.nix"
    done
    nix fmt -- packages/hyper-window-tiling/bun.nix packages/workstation/bun.nix
