#!/bin/sh
# Default tsc, tsgo, tsrs, and VS Code's SDK to the Hjem-pinned compiler
# compiler.mts redirects project-local TypeScript CLI launchers here too
# Only this explicit command loads the project's upstream compiler
if [ "${0##*/}" = tscn ]; then
	exec node "@HOME@/.local/lib/typescript/upstream.mts" "$@"
fi
exec bun "@HOME@/.local/lib/typescript/node_modules/tsrs/bin/tsrs" "$@"
