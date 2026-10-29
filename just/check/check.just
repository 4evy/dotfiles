import '../common.just'
import '../nix/system.just'

set working-directory := '../..'
# Check formatting in Nix's sandbox without rewriting the worktree
[group('check')]
format: (_doctor 'fmt')
    nix build --no-link --print-build-logs {{ quote('.#checks.' + nix_system + '.treefmt') }}

# Run the complete repository validation suite
[default]
all: _lint _nix

_lint:
    {{ just_command }} lint

_nix:
    {{ just_command }} nix check
