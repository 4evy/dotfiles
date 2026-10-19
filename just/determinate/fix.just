import '../common.just'
import '../nix/ensure.just'

set working-directory := '../..'
set default-list
# Replace incorrect Nix expression hashes, prompting before each edit by default
[arg('args', help='Arguments forwarded to determinate-nixd fix hashes')]
[group('dev')]
hashes *args: (_doctor 'nix') _ensure
    determinate-nixd fix hashes {{ quote(args) }}
