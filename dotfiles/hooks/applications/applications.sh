#!/bin/sh
if [ "$(uname -s)" = Darwin ]; then
	set -eu
	exec bun "$HJEM_WORKING_TREE/scripts/setup/ai/ai.ts" configure
fi
