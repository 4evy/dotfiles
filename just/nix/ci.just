import '../common.just'
import 'system.just'

set working-directory := '../..'
set default-list
# Evaluate the system configuration before the flake's import-from-derivation
# checks, then build the repository lint and formatting checks.
[group('check')]
check:
    nix eval --raw .#nixosConfigurations.nixos.config.system.build.toplevel.drvPath >/dev/null
    nix flake check --keep-going --no-build
    nix build --keep-going --print-build-logs \
      .#checks.{{ nix_system }}.pre-commit .#checks.{{ nix_system }}.treefmt
