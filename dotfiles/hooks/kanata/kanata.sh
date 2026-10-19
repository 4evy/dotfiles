#!/bin/sh
if [ "$(uname -s)" = Darwin ]; then
	set -eu
	cd "$HJEM_WORKING_TREE"
	exec just darwin
fi
