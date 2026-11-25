import '../module.just'

set default-list

# Keep the workspace's generated Nix dependency cache in sync
[group('check')]
check:
    mkdir -p .cache
    generated_dir=$(mktemp -d "$PWD/.cache/bun-nix.XXXXXX")
    trap 'rm -rf "$generated_dir"' EXIT
    generated="$generated_dir/bun.nix"
    bash tools/bun/generate-nix.sh "$generated"
    if ! diff -u bun.nix "$generated"; then
      printf 'bun.nix is stale, run `just bun nix update`.\n' >&2
      exit 1
    fi

# Regenerate the dependency cache from the workspace lockfile
[group('dev')]
update:
    bash tools/bun/generate-nix.sh
