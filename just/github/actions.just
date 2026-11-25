import '../module.just'

set default-list
[group('check')]
check:
    actionlint
    zizmor --offline --persona=pedantic .github/workflows .github/actions
