import '../module.just'
import '../nix/system.just'

# Check formatting in Nix's sandbox without rewriting the worktree
[group('check')]
format: (_doctor 'fmt')
    nix build --no-link --print-build-logs {{ quote('.#checks.' + nix_system + '.treefmt') }}

# Run the complete repository validation suite
[default]
all: lint (_just ['nix', 'check'])

# Run formatting, dependency, and source validation
[group('check')]
lint: (_just ['_lint'])
