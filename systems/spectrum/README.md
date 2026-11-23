# Spectrum

Run from the repository root:

```bash
just spectrum validate
just spectrum build   # Build only
just spectrum switch  # Build and stage recovery image without rebooting
```

The [BlueBuild recipe](recipes/spectrum.yml) tracks Bluefin Classic's NVIDIA
Open `stable` channel, currently on Fedora 45. Renovate refreshes the digest
without changing channels. The
[publish workflow](../../.github/workflows/spectrum.yaml) verifies that digest
before building `ghcr.io/4evy/spectrum` with Buildx. BlueBuild stores
intermediate layers in `:latest-cache`. CI signs and attests the digest returned
by the build, not the current value of `:latest`.

## Recovery SSH

`build` and `switch` accept an optional Wi-Fi profile name or UUID, defaulting
to the active connection. The profile must autoconnect, have no user
restriction, and store its PSK without a desktop secret agent

**Never publish `localhost/spectrum-recovery:latest`.** It contains the Wi-Fi
PSK and private SSH host key. Old image layers, `/boot`, backups, and
deployments retain these secrets

Connect from the LAN before the main OS mounts:

```bash
ssh -p 2222 root@<lan-ip>
```

Verify the fingerprint with
`sudo ssh-keygen -lf /var/lib/spectrum-recovery/ssh_host_ed25519_key.pub`.
Authentication uses the [managed key](files/system/etc/ssh/authorized_keys/evy).
After switch-root, use `evy` on port 22. No Tailscale in recovery

Use `just spectrum switch` for updates. Switching to a registry image removes
recovery. To refresh recovery without rebuilding the public image:

```bash
just spectrum recovery localhost/spectrum-recovery:latest <wifi-profile>
sudo bootc upgrade
```

Use bare `rd.break` for a breakpoint after networking starts. Earlier
breakpoints can prevent recovery SSH
