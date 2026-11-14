#!/usr/bin/bash
set -euo pipefail

if [[ $EUID != 0 || $# -lt 1 || $# -gt 2 ]]; then
	printf 'Usage: sudo bash %s BASE_IMAGE [WIFI_PROFILE]\n' "$0" >&2
	exit 1
fi
readonly base=$1
profile=${2:-}
readonly state=/var/lib/spectrum-recovery
readonly image=localhost/spectrum-recovery:latest
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd)
readonly root

# Serialize host key creation and replacement of the local recovery image
exec 9>/run/lock/spectrum-recovery.lock
flock 9
umask 077
install -d -m 0700 "$state"
if [[ ! -f $state/ssh_host_ed25519_key ]]; then
	ssh-keygen -q -t ed25519 -N '' -C 'Spectrum initramfs recovery' \
		-f "$state/ssh_host_ed25519_key"
fi
ssh-keygen -y -f "$state/ssh_host_ed25519_key" >"$state/ssh_host_ed25519_key.pub"

if [[ -z $profile ]]; then
	while IFS=: read -r uuid type; do
		if [[ $type == 802-11-wireless ]]; then
			profile=$uuid
			break
		fi
	done < <(nmcli --escape no -t -f UUID,TYPE connection show --active)
fi
if [[ -z $profile ]]; then
	printf 'No active Wi-Fi profile, pass one explicitly\n' >&2
	exit 1
fi
uuid=$(nmcli -g connection.uuid connection show "$profile")
if [[ $(nmcli -g connection.type connection show uuid "$uuid") != 802-11-wireless ||
$(nmcli -g connection.autoconnect connection show uuid "$uuid") != yes ||
-n $(nmcli -g connection.permissions connection show uuid "$uuid") ||
$(nmcli -g 802-11-wireless-security.psk-flags connection show uuid "$uuid") != 0 ]]; then
	printf 'Recovery needs a system-owned, autoconnect Wi-Fi profile with a stored PSK\n' >&2
	exit 1
fi
wifi_file=
while IFS=: read -r candidate path; do
	if [[ $candidate == "$uuid" ]]; then
		wifi_file=$path
		break
	fi
done < <(nmcli --escape no -t -f UUID,FILENAME connection show)
if [[ ! -f $wifi_file ]]; then
	printf 'Selected Wi-Fi profile has no readable keyfile\n' >&2
	exit 1
fi

# Secret changes do not invalidate Podman's cache, rebuild this small tail
TMPDIR=/var/tmp podman build --pull=never --no-cache --layers \
	--build-arg "BASE=$base" \
	--secret "id=recovery-wifi,src=$wifi_file" \
	--secret "id=recovery-host-key,src=$state/ssh_host_ed25519_key" \
	--secret "id=recovery-host-key-pub,src=$state/ssh_host_ed25519_key.pub" \
	--file "$root/systems/spectrum/recovery/Containerfile" \
	--tag "$image" "$root"
printf 'Private recovery image: %s\n' "$image"
ssh-keygen -lf "$state/ssh_host_ed25519_key.pub"
