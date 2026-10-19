import '../common.just'

set working-directory := '../..'
set default-list
# Format the root Justfile and every imported recipe file without starting Nix
[group('dev')]
fmt: *(_just-format *git_files(['Justfile', '*.just']))

# Check all Just files with the same native formatter
[group('check')]
check: *(_just-format *git_files(['Justfile', '*.just']) ['--check'])

_just-format file flags=[]:
    [[ -f {{ quote(file) }} && ! -L {{ quote(file) }} ]] || exit 0
    {{ quote([just_executable(), '--unstable', '--justfile', file, '--fmt', flags]) }}
