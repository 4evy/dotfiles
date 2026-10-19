import '../common.just'

set working-directory := '../..'
set default-list
[group('check')]
check:
    brew bundle list --file Brewfile --all >/dev/null
