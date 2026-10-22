#!/bin/sh
# Default tsc, tsgo, tsrs, and VS Code's SDK to the Hjem-pinned compiler
# compiler.mjs redirects project-local TypeScript CLI launchers here too
exec bun "@HOME@/.local/lib/typescript/node_modules/tsrs/bin/tsrs" "$@"
