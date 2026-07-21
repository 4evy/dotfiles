# dotfiles 🌸

Personal Spectrum/Bluefin, macOS, Homebrew, Ansible, and chezmoi setup.

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

The NixOS host keeps the same chezmoi and Ansible orchestration, but NixOS owns
all system, desktop, development, and repository-tool packages. The Ansible
roles deliberately skip Homebrew, Rustup, Bun-global, Nix-profile, downloaded
script, and source/archive installers when the detected distribution is NixOS.

From an installed NixOS system:

```bash
git clone https://github.com/4evy/dotfiles.git ~/dotfiles
cd ~/dotfiles
sudo nixos-rebuild switch --flake .#nixos
just setup
```

`just setup` still applies the shared Ansible playbooks and chezmoi source. On
NixOS, host and package state changes belong in `hosts/linux` or
`modules/nixos`, followed by another `nixos-rebuild`.

Spectrum's checked-in Bluetooth and systemd policy files are also the NixOS
source of truth: the NixOS module links them into the system configuration
without translating their contents into Nix. Cross-platform source builds use
the shared pins in `spectrum/scripts/spectrum_build/programs/source-pins.json`;
only the Fedora and Nix packaging recipes remain platform-specific.

### macOS

```bash
git clone https://github.com/4evy/dotfiles.git ~/dotfiles
cd ~/dotfiles
./ansible/bootstrap.sh ansible/playbooks/userland.yml
chezmoi init --source "$PWD"
chezmoi apply --refresh-externals=auto --force
```

## Commands

Run `just` to see every recipe and alias.

### Machine setup

```bash
just setup          # first full setup: userland, dotfiles, and host roles
just update         # refresh an already configured machine
just apply          # apply only chezmoi dotfiles
just nix            # install Nix and the repo's Nix profile tools
just doctor setup   # check dependencies needed for setup
just doctor all     # check every known workflow dependency
```

### Spectrum image

```bash
just status          # show bootc and image metadata
just install         # switch to the published Spectrum image
just build           # build localhost/spectrum:local using cached layers
just build-clean     # explicitly rebuild every image layer
just spectrum-dev    # compatibility name for the cached local build
just switch          # rebuild and switch/stage the local image
just upgrade         # rebuild the local image and stage a bootc upgrade
just reboot          # reboot through systemd
just spectrum-lint   # validate the image build scripts
just spectrum-diff   # compare RPMs in Bluefin and Spectrum
```

`just install`, `just switch`, and `just upgrade` handle bootc image updates;
`just update` only refreshes userland, dotfiles, and host roles.

### Development

```bash
just check           # run the full validation suite
just fmt             # format repository files
just check-format    # check formatting without changing files
just watch check     # rerun checks when files change
just smoke           # build and validate the Fedora smoke-test container
just smoke-shell     # open a shell in the smoke-test container
```

Focused checks:

```bash
go test ./...
just python-complexity
just python-dead-code
uv run --locked pytest
uv run spectrum-build check
bun run --filter hyper-window-tiling check
```

Python command surfaces use Cyclopts as their single CLI framework. Function
signatures and docstrings declare commands and help; `Parameter`, `Group`, and
environment configuration declare validation, aliases, and settings. Small
bootstrap scripts that must run before project dependencies are installed stay
on the standard library's `argparse`.

### Nix and Ansible

```bash
nix flake check
nix run .#ghidra-mcp
sudo nixos-rebuild switch --flake .#nixos

ansible-playbook ansible/playbooks/host.yml
ansible-playbook ansible/playbooks/site.yml
```

## License

[LICENSE](LICENSE)
