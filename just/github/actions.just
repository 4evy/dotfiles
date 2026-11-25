import '../module.just'

set default-list
[group('check')]
check:
    actionlint
    zizmor --persona=pedantic .github/workflows .github/actions
