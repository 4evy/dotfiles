import '../module.just'

set default-list
# Format Just files through treefmt
[group('dev')]
fmt:
    nix fmt . -- --formatters just

# Check Just formatting through treefmt
[group('check')]
check:
    nix fmt . -- --formatters just --fail-on-change
