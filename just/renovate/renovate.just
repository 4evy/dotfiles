import '../common.just'

set working-directory := '../..'
set default-list
[group('check')]
check:
    cd .github/renovate
    bun install --frozen-lockfile
    bun run validate
    bun run extract
