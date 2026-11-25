import '../module.just'
import 'clean.just'

set default-list

# Check one workflow's commands, or every workflow when omitted
[arg('profile', pattern=['status', 'reboot', 'install', 'build', 'setup', 'reconcile', 'apply', 'records', 'sops', 'shell', 'spectrum', 'fmt', 'lint', 'bun', 'nix', 'watch', 'check', 'all'], help='Workflow to check')]
[group('system')]
doctor profile='all': (_doctor profile)

# Show bootc and image metadata status.
[group('system')]
[linux]
status: (_doctor 'status')
    sudo bootc status
    if [[ -r /usr/share/ublue-os/image-info.json ]] && command -v jq >/dev/null 2>&1; then
      jq . /usr/share/ublue-os/image-info.json
    fi

# Reboot the host.
[confirm('Reboot this host now?')]
[group('system')]
[linux]
reboot: (_doctor 'reboot')
    systemctl reboot
