#!/bin/sh
# Share the pinned Rust compiler and language server across CLI and editors
set -- bun "@HOME@/.local/lib/node_modules/tsrs/bin/tsrs" "$@"
# Keep CLI and editor work below interactive tasks without pausing LSP traffic
if [ "$(uname -s)" = Darwin ]; then
	set -- /usr/sbin/taskpolicy -c utility "$@"
fi
exec "$@"
