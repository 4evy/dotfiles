import 'clean.just'

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
