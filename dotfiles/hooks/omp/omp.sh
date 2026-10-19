#!/bin/sh
if [ "$(uname -s)" = Darwin ] || [ "$(uname -s)" = Linux ]; then
	set -eu
	exec bun install --cwd "$HJEM_HOME_DIR/.omp/agent" --ignore-scripts
fi
