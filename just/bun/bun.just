import '../common.just'
mod nix 'nix.just'

set working-directory := '../..'
set default-list
[group('check')]
check: (_doctor 'bun')
    bun run check
# Use `bun run <tool>` to prefer local binaries without bunx cache fallback
# Name wrappers `check:<tool>` so `bun run <tool>` cannot recurse into a script
# Keep the workspace and independently packaged tools on their committed locks
[group('dev')]
install:
    bun install --frozen-lockfile
    bun install --cwd packages/hyper-window-tiling --frozen-lockfile
    bun install --cwd packages/workstation --frozen-lockfile --ignore-scripts
