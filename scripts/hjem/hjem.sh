#!/usr/bin/env bash
set -euo pipefail
# Keep CDPATH lookup and its directory output out of the captured repository path
repository=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
exec bun "$repository/scripts/hjem/hjem.ts" "$@"
