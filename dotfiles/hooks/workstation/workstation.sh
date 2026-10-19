#!/bin/sh
if [ "$(uname -s)" = Darwin ] || [ "$(uname -s)" = Linux ]; then
	set -eu
	exec bun "$HJEM_WORKING_TREE/scripts/setup/workstation.ts"
fi
