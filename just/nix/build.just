import '../common.just'
import 'system.just'

set working-directory := '../..'
set default-list
[group('check')]
check name:
    nix build --print-build-logs {{ quote('.#checks.' + nix_system + '.' + name) }}
