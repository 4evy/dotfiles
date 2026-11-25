import '../module.just'

set default-list
[group('check')]
[working-directory('.github/renovate')]
check:
    bun install --frozen-lockfile
    bun run validate
    bun run extract
