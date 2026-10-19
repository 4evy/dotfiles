#!/bin/sh
if [ "$(uname -s)" = Linux ]; then
	set -eu
	exec python3.14 "$HJEM_WORKING_TREE/scripts/setup/toshy.py"
fi
