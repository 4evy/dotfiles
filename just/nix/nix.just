import '../common.just'
import 'ensure.just'
mod build 'build.just'
mod ci 'ci.just'
mod native 'native.just'

set working-directory := '../..'
# Evaluate every flake output without building package derivations.
[group('check')]
check: (_doctor 'fmt') ci::_eval-system
    nix flake check --all-systems --keep-going --no-build --no-eval-cache
# Update selected inputs, or all inputs
[arg('inputs', help='Input names to update; omit to update all')]
[group('dev')]
update *inputs: (_doctor 'nix')
    nix flake update {{ quote(inputs) }}

# Install Nix and activate the Linux user environment through Hjem
[default]
[group('setup')]
install: (_doctor 'nix') _ensure
    if [[ {{ quote(host_os) }} == macos ]]; then
      printf '%s\n' 'Darwin owns these tools, use just darwin to rebuild them.'
      exit 0
    fi
    if [[ -e /etc/NIXOS ]]; then
      printf '%s\n' 'NixOS owns these tools, rebuild the system to upgrade them.'
      exit 0
    fi
    {{ just_command }} hjem
