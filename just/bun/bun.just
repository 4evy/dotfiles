import '../common.just'
mod nix 'nix.just'

set working-directory := '../..'
set default-list
[group('check')]
check: (_doctor 'bun')
    bun run check
[group('dev')]
install:
    bun install --frozen-lockfile
    bun install --cwd packages/hyper-window-tiling --frozen-lockfile
    bun install --cwd packages/workstation --frozen-lockfile --ignore-scripts
