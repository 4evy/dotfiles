import '../common.just'

set working-directory := '../..'
set default-list

# Keep manifest paths NUL-delimited for native dependency mapping
[private]
nix_projects := nul_split(shell('''jq -j '.[] | select(.nix) | .directory + "\u0000"' data/bun/projects.json'''))

# Keep the workspace's generated Nix dependency cache in sync
[group('check')]
check: *(_check *nix_projects)

# Each mapped check owns its generated file and cleanup
_check package:
    generated_dir=$(mktemp -d)
    trap 'rm -rf "$generated_dir"' EXIT
    generated="$generated_dir/bun.nix"
    nix run .#bun2nix -- \
      --lock-file {{ quote(package / 'bun.lock') }} \
      --copy-prefix "./" \
      --output-file "$generated"
    deadnix --edit "$generated"
    nixfmt "$generated"
    if ! diff -u {{ quote(package / 'bun.nix') }} "$generated"; then
      printf '%s/bun.nix is stale, run `just bun nix update`.\n' {{ quote(package) }} >&2
      exit 1
    fi

# Regenerate dependency caches from their owning lockfiles
[group('dev')]
update: *(_update *nix_projects)

_update package:
    nix run .#bun2nix -- \
      --lock-file {{ quote(package / 'bun.lock') }} \
      --copy-prefix "./" \
      --output-file {{ quote(package / 'bun.nix') }}
    deadnix --edit {{ quote(package / 'bun.nix') }}
    nixfmt {{ quote(package / 'bun.nix') }}
