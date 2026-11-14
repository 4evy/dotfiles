# Spectrum

Run from the repository root:

```bash
just spectrum validate
just spectrum build   # Build only
just spectrum switch  # Build and stage, or `rebuild` in an interactive shell
```

Recipe: [`recipes/spectrum.yml`](recipes/spectrum.yml)

Spectrum uses Bluefin's Fedora 45 NVIDIA Open image, pinned in the recipe and
[`spectrum.lock`](recipes/spectrum.lock). The `45` tag keeps digest updates on
Fedora 45 rather than following `latest` across major releases

## Editing

- Put local image resources in `files/system/`, preserving `etc/` and `usr/`
  paths. Add them through the [files stage](recipes/spectrum/stages/files.yml),
  not another final-image `COPY`
- Keep source, palette, and extension metadata in consumer stages to reuse the
  shared [dependency layer](recipes/spectrum/stages/bun-dependencies.yml)
- Keep versioned RPM URLs after the bulk package and extension modules in
  [`software.yml`](recipes/spectrum/modules/software.yml) so updates reuse those
  earlier layers
- Use bootc for updates so `/usr/lib/bootc/kargs.d` arguments apply
- Keep Bluefin's bundled Homebrew setup. The BlueBuild `brew` module replaces
  it. Update Brew manually with `just update`
- Use the locked Nixpkgs unstable `bluebuild` package for local tooling and CI.
  The upstream overlay retains only switch-validation and driver-selection fixes
- A shared module `source` image overrides the version in `type`
- Use `script@v2` for multiline snippets. Version 1 splits shell control flow
- Keep the digest-pinned `main-installer`. Release installers lack `bootc` and
  `recipe-v2`
- Use `just spectrum validate` for v2 recipes. The CLI validator selects v1

## Recovery SSH

Local builds create rootful `localhost/spectrum:latest` and a private
`localhost/spectrum-recovery:latest` derivative. `switch` stages the private
image without rebooting. Both commands accept an optional Wi-Fi profile name or
UUID, otherwise they select the active Wi-Fi connection. The profile must
autoconnect, have no user restriction, and store its PSK without a desktop
secret agent

To add recovery to an existing rootful Spectrum image without a full rebuild:

```bash
just spectrum recovery localhost/spectrum:latest 5ghz
sudo bootc switch --transport containers-storage localhost/spectrum-recovery:latest
```

The [private builder](recovery/build.sh) reads the selected NetworkManager
keyfile and keeps a separate SSH host key under `/var/lib/spectrum-recovery`.
Podman secret mounts supply these to the initramfs build. Credentials stay out
of the checkout, Nix store, and public image

**Never publish the recovery image.** Its initramfs contains the Wi-Fi PSK and
private host key. Treat local image layers, `/boot`, backups, and old
deployments as sensitive. Rebuilding does not erase secrets from older copies

Before the main OS mounts, connect from the LAN:

```bash
ssh -p 2222 root@<lan-ip>
```

Verify its fingerprint against
`sudo ssh-keygen -lf /var/lib/spectrum-recovery/ssh_host_ed25519_key.pub`.
Authentication uses the
[managed public key](files/system/etc/ssh/authorized_keys/evy), never a
password. After switch-root, that session ends and normal key-only SSH uses
`evy` on port 22 with the normal host key

The
[initramfs module](files/system/usr/lib/dracut/modules.d/91spectrum-wifi/module-setup.sh)
includes Intel AX200 Wi-Fi support and wired DHCP. Networking runs in the
background without delaying a healthy local boot for an unavailable AP.
Tailscale is not included, so off-site recovery needs an independent route into
the LAN

Use bare `rd.break` for a deliberate late-initramfs breakpoint. Earlier
breakpoints such as `rd.break=cmdline` and `rd.break=pre-trigger` can stop boot
before networking starts. Broken kernels, initramfs images, or network drivers
still require a working deployment or out-of-band access

Use `just spectrum switch` for updates so each new public build gets a fresh
private initramfs. Plain `bootc upgrade` only consumes the already-built local
image. Switching directly to a registry image removes this recovery setup

## CI caching

The [build preparation](../../.github/actions/spectrum/prepare/action.yaml)
installs
[runner-only storage options](../../.github/actions/spectrum/build/storage.conf)
before Podman's first probe. Keep native overlay diffs enabled so committing a
small change does not scan the entire Bluefin filesystem. These options do not
change workstation storage

Spectrum reuses registry layers and its runtime-tooling archive. Nix check jobs
use a separate
[build-output archive](../../.github/actions/setup/nix/action.yaml) instead of
per-path GitHub cache requests. The [export recipe](../../just/nix/ci.just)
retains unsigned build outputs, including intermediate compiler artifacts, while
signed dependencies come from upstream binary caches
