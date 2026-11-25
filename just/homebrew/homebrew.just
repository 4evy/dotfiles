import '../module.just'

set default-list
[env('HOMEBREW_NO_AUTO_UPDATE', '1')]
[group('check')]
check:
    brew bundle list --file Brewfile --all >/dev/null
