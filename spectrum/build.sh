#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

cd "$script_dir"
exec uv run --locked spectrum-build "$@"
