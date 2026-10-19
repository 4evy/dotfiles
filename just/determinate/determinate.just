import '../common.just'
import '../nix/ensure.just'
mod fix 'fix.just'

set working-directory := '../..'
set default-list
# Show the installed distribution, enabled features, and daemon status
[group('system')]
status: (_doctor 'nix') _ensure
    nix --version
    determinate-nixd version
    determinate-nixd status

# Upgrade installer-managed Determinate Nix (NixOS is updated through its flake lock)
[confirm('Upgrade this installer-managed Determinate Nix installation?')]
[group('system')]
upgrade: (_doctor 'nix') _ensure
    : {{ assert(!path_exists('/etc/NIXOS'), 'NixOS manages Determinate declaratively; update flake.lock and rebuild instead.') }}
    sudo determinate-nixd upgrade
