# dotfiles 🌸

Personal Spectrum/Bluefin, NixOS, and macOS workstation configuration, built
with Homebrew, Nix, Ansible, and chezmoi.

<p>
  <a href="https://github.com/4evy/dotfiles/pkgs/container/spectrum"><img alt="GHCR Spectrum image" src="https://img.shields.io/badge/GHCR-spectrum-f4b8e4?style=flat-square&logo=github&logoColor=f4b8e4&labelColor=232634"></a>
</p>

<p>
  <a href="https://projectbluefin.io"><img alt="Bluefin" src="https://img.shields.io/badge/Bluefin-f4b8e4?style=flat-square&logo=fedora&logoColor=f4b8e4&labelColor=232634"></a>
  <a href="https://nixos.org"><img alt="NixOS" src="https://img.shields.io/badge/NixOS-f4b8e4?style=flat-square&logo=nixos&logoColor=f4b8e4&labelColor=232634"></a>
  <a href="https://www.apple.com/macos"><img alt="macOS" src="https://img.shields.io/badge/macOS-f4b8e4?style=flat-square&logo=apple&logoColor=f4b8e4&labelColor=232634"></a>
</p>

<p>
  <a href="https://brew.sh"><img alt="Homebrew" src="https://img.shields.io/badge/Homebrew-f4b8e4?style=flat-square&logo=homebrew&logoColor=f4b8e4&labelColor=232634"></a>
  <a href="https://www.chezmoi.io"><img alt="chezmoi" src="https://img.shields.io/badge/chezmoi-f4b8e4?style=flat-square&logo=homeassistant&logoColor=f4b8e4&labelColor=232634"></a>
  <a href="https://www.ansible.com"><img alt="Ansible" src="https://img.shields.io/badge/Ansible-f4b8e4?style=flat-square&logo=ansible&logoColor=f4b8e4&labelColor=232634"></a>
  <a href="https://catppuccin.com"><img alt="Catppuccin Latte and Frappe" src="https://img.shields.io/badge/Catppuccin-Latte%20%2B%20Frapp%C3%A9-f4b8e4?style=flat-square&labelColor=ea76cb"></a>
</p>

> [!IMPORTANT]
> This is my personal setup.

## Setup

### Spectrum / Bluefin

Start from a fresh Bluefin install:

```bash
git clone https://github.com/4evy/dotfiles.git ~/dotfiles
cd ~/dotfiles
sudo bootc switch ghcr.io/4evy/spectrum:latest
systemctl reboot
```

After rebooting into Spectrum, finish the machine setup:

```bash
cd ~/dotfiles
just setup
```

### NixOS

The NixOS flake owns the declarative host, desktop, development, and package state.
Ansible still performs platform detection, but skips the userland and host stages that
NixOS owns

From an installed NixOS system:

```bash
git clone https://github.com/4evy/dotfiles.git ~/dotfiles
cd ~/dotfiles
sudo nixos-rebuild switch --flake .#nixos
just setup
```

`just setup` runs the shared bootstrap orchestration and applies the chezmoi source. On
NixOS, host and package changes belong in `hosts/linux` or `modules/nixos`, followed by
another `nixos-rebuild`

Spectrum's checked-in Bluetooth and systemd policy files are also the NixOS source of
truth: the NixOS module links them into the system configuration without translating
their contents into Nix. Shared source pins and Spectrum program definitions live in
`manifests/sources.json` and `manifests/spectrum-programs.toml`

### macOS

```bash
git clone https://github.com/4evy/dotfiles.git ~/dotfiles
cd ~/dotfiles
./ansible/bootstrap.sh --tags userland
just setup
```

## Commands

Run `just` or `just --list` to see the public recipes available on the current platform.
Optional arguments are shown in brackets below

### Setup and system

```bash
just setup             # Bootstrap userland, apply dotfiles, then apply host stages (alias: s)
just update            # Refresh userland, dotfiles, and host stages (alias: up)
just apply             # Apply only the chezmoi-managed dotfiles (alias: a)
just nix               # Install Nix and add the repository's Nix profile tools (alias: nx)
just doctor [profile]  # Check workflow dependencies; defaults to setup
just status            # Show bootc status and image metadata on Linux
just clean             # Reclaim disposable data on Linux after confirmation
just reboot            # Reboot through systemd on Linux after confirmation (alias: r)
```

Doctor profiles are `status`, `reboot`, `install`, `build`, `setup`, `apply`,
`shell`, `spectrum`, `fmt`, `lint`, `c`, `ansible`, `bun`, `smoke`, `nix`,
`watch`, `check`, and `all`.

### Spectrum image

These image lifecycle commands are Linux-only except for `spectrum-lint`.
`target` defaults to `localhost/spectrum:local` for local operations and
`ghcr.io/4evy/spectrum:latest` for `install`

```bash
just install [target]               # Switch to the published image on next boot (alias: i)
just build [target]                 # Build the local image with cached layers (alias: b)
just build-clean [target]           # Rebuild the local image without cached layers
just spectrum-dev [target]          # Compatibility name for the cached local build
just switch [target]                # Build and switch to or stage the local image (alias: sw)
just upgrade [target]               # Rebuild the image and stage a bootc upgrade (alias: u)
just spectrum-lint                  # Validate build scripts without building an image
just spectrum-boot-report [target]  # Report boot and kernel artifact sizes
just spectrum-diff [target] [base]  # Compare Spectrum RPMs with its Bluefin base
```

Image defaults can be overridden with `SPECTRUM_IMAGE_NAME`,
`SPECTRUM_LOCAL_TAG`, `SPECTRUM_REMOTE_REF`, and the
`SPECTRUM_BLUEFIN_BASE_IMAGE*` variables. The base image reference must end in
a SHA-256 digest. `PODMAN` and `COMPOSE` select alternative container commands.

`just install`, `just switch`, and `just upgrade` handle bootc image updates;
`just update` only refreshes userland, dotfiles, and host stages.

### Development

```bash
just check                            # Run the complete validation suite (aliases: c, ck)
just lint                             # Check formatting, lint, and validate (alias: l)
just fmt                              # Format repository files (alias: f)
just check-format                     # Check formatting without changes (alias: cf)
just watch [recipe and arguments]     # Rerun a recipe on changes; defaults to check (alias: w)
just manifest-check                   # Validate manifests and generated schemas
just manifest-update-schemas          # Regenerate JSON Schemas from runtime models
just python-dependencies              # Check dependencies against first-party imports
just python-test [pytest arguments]   # Run tests with optional pytest arguments
just python-typecheck [ty arguments]  # Type-check roots with optional ty arguments
just python-dead-code                 # Scan configured Python roots for dead code
just python-complexity                # Enforce the cognitive-complexity limit
just smoke                            # Build and validate the Fedora smoke-test container
just smoke-shell                      # Open a shell in the Fedora smoke-test container
```

Python command surfaces use Cyclopts as their single CLI framework. Function signatures
and docstrings declare commands and help; `Parameter`, `Group`, and environment
configuration declare validation, aliases, and settings. Small bootstrap scripts that
must run before project dependencies are installed stay on the standard library's
`argparse`

### Nix and Ansible

```bash
nix flake check
nix run .#ghidra-mcp
sudo nixos-rebuild switch --flake .#nixos

./ansible/bootstrap.sh --tags userland
ansible-playbook ansible/site.yml --tags host
ansible-playbook ansible/site.yml
```

## License

[LICENSE](LICENSE)
