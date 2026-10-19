import '../common.just'
import 'system.just'

set working-directory := '../..'
set default-list
# Exclude the complete OS build and the repository checks already run above.
# Discover package checks from the flake instead of keeping a list in YAML.
[group('check')]
checks:
    nix eval --json .#lib.checkNames.{{ nix_system }} | \
      jq -c 'map(select(. != "pre-commit" and . != "treefmt" and . != "nixos"))'
