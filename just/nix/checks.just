import '../module.just'
import 'system.just'

set default-list
# Build one named flake check
[group('check')]
build name:
    nix build --no-link --print-build-logs {{ quote('.#checks.' + nix_system + '.' + name) }}

# Exclude the complete OS build and the repository checks run separately in CI
# Discover names without forcing package derivations or keeping a list in YAML
[group('check')]
list:
    nix eval --json .#lib.checkNames.{{ nix_system }} | \
      jq -c 'map(select(. != "pre-commit" and . != "treefmt" and . != "nixos"))'
