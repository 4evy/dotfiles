import '../common.just'

set working-directory := '../..'
# Run the same treefmt wrapper in CI mode without retaining rewrites.
[group('check')]
format: (_doctor 'fmt')
    nix fmt -- --ci

# Run the complete repository validation suite
[default]
all: _lint _nix

_lint:
    {{ just_command }} lint

_nix:
    {{ just_command }} nix check
