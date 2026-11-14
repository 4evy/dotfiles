#!/usr/bin/bash

# Dracut supplies the module paths and installation helpers when sourcing this
# shellcheck disable=SC2154

check() {
	require_binaries NetworkManager wpa_supplicant || return 1
	# Only the private, machine-local build enables recovery networking
	return 255
}

depends() {
	echo network-manager
}

installkernel() {
	# iwlwifi loads iwlmvm dynamically, outside normal module dependencies
	hostonly='' instmods iwlwifi iwlmvm
}

install() {
	inst_libdir_file 'NetworkManager/*/libnm-device-plugin-wifi.so'
	inst_multiple wpa_supplicant \
		"$dbussystem/wpa_supplicant.conf" \
		"$dbussystemservices/fi.w1.wpa_supplicant1.service" \
		"$systemdsystemunitdir/wpa_supplicant.service" \
		/usr/lib/firmware/regulatory.db \
		/usr/lib/firmware/regulatory.db.p7s
	# Fedora's unit references these files even when NM supplies credentials
	inst_multiple -o /etc/sysconfig/wpa_supplicant \
		/etc/wpa_supplicant/wpa_supplicant.conf
	inst_simple "$moddir/wpa-supplicant-initrd.conf" \
		"$systemdsystemunitdir/wpa_supplicant.service.d/initrd.conf"
	for unit in nm-initrd NetworkManager-initrd; do
		inst_simple "$moddir/network-manager-initrd.conf" \
			"$systemdsystemunitdir/$unit.service.d/recovery.conf"
	done
	# Recovery must not make a healthy local boot wait for an unavailable AP
	$SYSTEMCTL --root "$initdir" mask \
		nm-wait-online-initrd.service NetworkManager-wait-online-initrd.service
	inst_simple "$moddir/recovery-ethernet.nmconnection" \
		/etc/NetworkManager/system-connections/recovery-ethernet.nmconnection
	/usr/bin/install -Dm 0600 /run/secrets/recovery-wifi \
		"$initdir/etc/NetworkManager/system-connections/recovery-wifi.nmconnection"
	chmod 0600 "$initdir/etc/NetworkManager/system-connections/"*.nmconnection
	# Public-key root login needs an unlocked account, never a root password
	printf 'root:*:1:0:99999:7:::\n' >"$initdir/etc/shadow"
	chmod 0600 "$initdir/etc/shadow"
}
