import '../common.just'
import 'system.just'

set working-directory := '../..'
set default-list
# Exclude the complete OS build and the repository checks run separately in CI
# Discover names without forcing package derivations or keeping a list in YAML
[group('check')]
checks:
    nix eval --json .#lib.checkNames.{{ nix_system }} | \
      jq -c 'map(select(. != "pre-commit" and . != "treefmt" and . != "nixos"))'
