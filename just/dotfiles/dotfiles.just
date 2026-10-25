import '../common.just'

set working-directory := '../..'
set default-list
# Preview pending Hjem-managed home changes
[group('setup')]
diff: (_doctor 'apply')
    bun {{ quote(repo_dir / 'scripts/hjem/hjem.ts') }} diff
