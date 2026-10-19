# Match the current runner rather than duplicating its Nix system in workflows
[private]
nix_system := arch() + '-' + (if os() == 'macos' { 'darwin' } else { os() })
