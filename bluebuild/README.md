# Spectrum

This directory defines Spectrum, our Bluefin-based machine image and non-NixOS
Linux distribution

Spectrum combines BlueBuild for the operating-system image, Ansible for
mutable host configuration, Homebrew for programs, and chezmoi for the user
environment. Nix is installed, but it is not used as a general program manager

The Nix profile is limited to tools that support Nix development itself:

- `deadnix`
- `nh`
- `nil`
- `nix-instantiate`
- `nom`
- `nix-tree`
- `nixd`
- `nixfmt`

Everyday applications and workstation features remain outside Nix. Nix is
available for repository development and on-demand project outputs without
becoming the owner of the machine

## BlueBuild CLI and build flow

Spectrum includes the BlueBuild CLI at `/usr/bin/bluebuild`, together with
Podman and the other runtime tools it needs to build images. The embedded CLI is
built from the `source-bluebuild-cli` pin in `flake.lock` inside a stage that
uses the locked Bluefin base, so its glibc matches the final image. The recipe
opts out of BlueBuild's upstream installer tag.

Use `just spectrum-build` to build the local image. The repository-root
`recipes` symlink points here to `bluebuild/recipes`, so BlueBuild resolves
`from-file` imports through its native recipe directory. The build context
stays at the repository root so stages can copy shared packages and dotfiles.

BlueBuild supplies locked package-manager cache mounts to every module. Local
Podman builds reuse those mounts and unchanged image layers. Published CI
builds additionally set `BB_CACHE_LAYERS=true`, which imports and exports the
registry cache at `ghcr.io/4evy/spectrum:latest-cache`. Pull-request builds
stay read-only while importing that registry cache and using a branch-aware
GitHub Actions layer cache, so they reuse work without pushing temporary
images.

The top-level recipe is intentionally only an assembly manifest. Expensive
build stages live under `recipes/spectrum/stages`, while main-image modules
are ordered under `recipes/spectrum/modules` from remote-heavy software
installation to local files and system policy. This ordering means edits to
local configuration do not invalidate package, font, extension, or Linuxbrew
layers.

Use `nix flake update` at the repository root to update source inputs and all
Nix dependencies, including the development and NixOS partitions. Release
versions remain explicit in `flake.nix`; Renovate bumps those URLs and updates
the lock. Sources tied to patch stacks retain their fixed revisions.

Astral, Ghostty, and Kanata consume small files generated from `flake.lock`
under `recipes/spectrum/sources`. Build preparation regenerates these files and
`recipes/.spectrum.generated.yml` automatically. Both are ignored by Git, so a
lock update cannot leave tracked copies stale. Each stage includes only the
inputs it needs, preserving its cache across unrelated source updates.

Ghostty and Kanata fetch their source and shared patch queues at locked Git
revisions. File downloads use the NAR hashes recorded by Nix. The Ghostty stage
also mounts persistent global and local Zig caches, allowing compilation
artifacts to survive a source or patch cache miss.

The repository-local Hyper window tiler is also built once in a pinned Bun
stage and copied into the system GNOME and KWin extension directories.
Per-user Ansible work is therefore limited to enabling the extension and
setting desktop shortcuts.

The pinned Kanata executable, configuration, device policy, and system service
are built into the image together. Ansible only reconciles the live user's
device-group membership, disables a conflicting remapper when requested, and
starts the service. Spectrum also owns and globally enables the static Toshy
user units that connect Toshy to Kanata; Ansible retains the pinned upstream
installer and live service reconciliation.

The stable Sushi Flatpak is installed by the image's per-user Flatpak service.
Flatpak owns its matching graphics-driver extensions, while chezmoi owns the
one user override needed for reliable preview rendering.

Homebrew owns portable userland payloads that do not need to be frozen into
the image, including Helium, its profile configurer, Equilotl, and the
repository-pinned `yt-dlp-script`. Chezmoi owns their user launchers and
post-install reconciliation; Ansible no longer downloads those programs
itself.
