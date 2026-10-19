#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

generator="${HJEM_HOME_DIR}/.local/lib/ghostty/ghostty.ts"
if [[ -x "$generator" ]]; then
	"$generator"
fi
