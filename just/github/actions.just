import '../common.just'

set working-directory := '../..'
set default-list
[group('check')]
check:
    actionlint
    zizmor --persona=pedantic .github/workflows .github/actions
