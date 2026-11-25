import '../module.just'
mod nix 'nix.just'

set default-list
[group('check')]
check: (_doctor 'bun')
    bun run check
# Install checkout packages through the root workspace lock
[group('dev')]
install:
    bun install --frozen-lockfile
