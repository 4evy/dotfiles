#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

readonly installer="$HJEM_HOME_DIR/.local/lib/external/external.sh"
if [[ ! -x $installer ]]; then
	printf 'external CLI installer is missing: %s\n' "$installer" >&2
	exit 1
fi
"$installer"
