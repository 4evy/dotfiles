#!/bin/sh
# Use the pinned Rust compiler for CLI and editor entrypoints
exec bun "@HOME@/.local/lib/node_modules/tsrs/bin/tsrs" "$@"
