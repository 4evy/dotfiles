# Format the repository through treefmt
[group('dev')]
fmt:
    nix fmt .

# Rerun a recipe when files change.
[arg('args', help='Recipe and arguments to rerun on file changes')]
[group('dev')]
watch +args=['check']: (_doctor 'watch')
    watchexec --clear --restart --shell=none -- {{ just_command }} {{ quote(args) }}
