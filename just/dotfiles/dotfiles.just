import '../common.just'

set working-directory := '../..'
set default-list
# Preview pending Hjem-managed home changes
[group('setup')]
diff: (_doctor 'apply')
    scripts/hjem/hjem.sh diff
