import '../common.just'
import '../sops/vaults.just'

set working-directory := '../..'
set default-list
# Materialize records at their native source paths, or pass an external workspace.
[arg('workspace', max='1', help='Optional protected workspace outside the repository')]
[group('secrets')]
unpack *workspace: (_records ['unpack', workspace])

# Re-encrypt materialized records, or pass an external protected workspace.
[arg('workspace', max='1', help='Optional protected workspace outside the repository')]
[group('secrets')]
pack *workspace: (_records ['pack', workspace])

# Validate the encrypted vault, or pass a protected workspace to validate it.
[arg('workspace', max='1', help='Optional protected workspace outside the repository')]
[group('secrets')]
check *workspace: (_records ['check', workspace])

# Materialize and edit the source tree, or open one target or source path.
[arg('target', max='1', help='Optional record target or native source path')]
[group('secrets')]
edit *target: (_records ['edit', target])

# Decrypt and show target-to-source record mappings and attributes.
[group('secrets')]
layout: (_records ['layout'])

# Decrypt records into protected runtime files and emit a Hjem manifest
[group('secrets')]
deploy *args: (_records ['deploy', args])
[env('SOPS_AGE_KEY_CACHE', 'records')]
_records +args: (_doctor 'records')
    bun tools/records/main.ts {{ quote(args) }}
