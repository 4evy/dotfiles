import '../common.just'

set working-directory := '../..'
set default-list
# Scan the first-party Python source roots configured in pyproject.toml.
[group('check')]
code:
    uv run vulture
