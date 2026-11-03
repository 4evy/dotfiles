#!/bin/sh
# Share the pinned Rust compiler and language server across CLI and editors
exec bun "@HOME@/.local/lib/node_modules/tsrs/bin/tsrs" "$@"
