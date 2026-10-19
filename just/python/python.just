import '../common.just'
mod dead 'dead.just'

set working-directory := '../..'
set default-list
# Validate Toshy's Python sources with the same checks locally and in CI
[group('check')]
check: lint complexity dead::code dependencies typecheck
    uv lock --check
    uv sync --check
    bytecode_dir=$(mktemp -d)
    trap 'rm -rf "$bytecode_dir"' EXIT
    PYTHONPYCACHEPREFIX="$bytecode_dir" uv run python -m compileall -q packages/toshy-user scripts/setup/toshy.py

[group('check')]
lint:
    uv run ruff check .

# Check declared dependencies against first-party imports.
[group('check')]
dependencies:
    uv run deptry

# Type-check the Python source roots configured in pyproject.toml.
[arg('args', help='Arguments forwarded to ty check')]
[group('check')]
typecheck *args:
    uv run ty check {{ quote(args) }}
# Reject cognitively complex functions in the configured Python source roots.
[group('check')]
complexity:
    uv run complexipy --plain
