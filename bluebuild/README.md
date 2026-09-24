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
Podman and the other runtime tools it needs to build images. Build preparation
sets BlueBuild's native CLI installer version from the `source-bluebuild-cli`
revision in `flake.lock`. Upstream's commit-tagged installer supplies a static
musl binary, so the image does not need a separate Rust build stage or matching
glibc versions. Main-branch installers enable all features, including `bootc`
and `recipe-v2`; the Nix build tool enables those same two features. Deployment
commands therefore prefer bootc when it is available. Recipe validation still
uses the official v2 JSON schema because the CLI's validator currently selects
the v1 schema.

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
local configuration do not invalidate package, font, or extension layers.

Use `nix flake update` at the repository root to update source inputs and all
Nix dependencies, including the development and NixOS partitions. Release
versions remain explicit in `flake.nix`; Renovate bumps those URLs and updates
the lock. Sources tied to patch stacks retain their fixed revisions.

Astral, Ghostty, and Kanata consume small files generated from `flake.lock`
under `recipes/spectrum/sources`. Build preparation regenerates these files and
`recipes/.spectrum.generated.yml` automatically. Both are ignored by Git, so a
lock update cannot leave tracked copies stale. Each stage includes only the
inputs it needs, preserving its cache across unrelated source updates.

Ghostty and Kanata build on the locked Bluefin base so their runtime libraries
match the final image. They fetch their source and shared patch queues at locked
Git revisions. File downloads use the NAR hashes recorded by Nix. The Ghostty
stage also mounts persistent global and local Zig caches, allowing compilation
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

## Bluefin integration

Spectrum inherits Bluefin's Homebrew payload, setup service, and shell
integration. The BlueBuild `brew` module used an older extracted payload and
replaced those services, so it is no longer included. Existing installations
keep `/home/linuxbrew/.linuxbrew`; fresh installations use Bluefin's bundled
tarball. Spectrum disables the Brew update timers and automatic uupd Brew
module, keeps analytics disabled, and leaves upgrades to `just update`.

The DNF module imports the 1Password and VS Code repository definitions from
the native `files/dnf` directory at the repository root and removes them after
installation. It also manages the Vicinae COPR and disables it after package
installation. Keeping only DNF inputs in `files` avoids invalidating package
layers when other system configuration changes.

System configuration is installed into `/etc`, and kernel
arguments use bootc's `/usr/lib/bootc/kargs.d` through the `kargs` module.
Use bootc for image updates so those arguments are applied.

Each external module uses its own versioned image and digest, tracked by
Renovate. Major module migrations also require recipe changes, so Renovate
updates these image digests without changing their version tags. A shared
`source` image overrides the module version selector and can silently run a
different implementation from the one named in `type`.

Shell snippets use `script@v2`, which preserves multiline snippets and runs
them with `/bin/sh -c` and `set -eu`. The v1 module split multiline snippets
into separate commands, breaking heredocs and shell control flow.

Upstream references:

- [BlueBuild script module](https://blue-build.org/reference/modules/script/)
- [BlueBuild DNF migration](https://blue-build.org/blog/dnf-module/)
- [BlueBuild kernel arguments](https://blue-build.org/reference/modules/kargs/)
- [Bluefin build](https://github.com/projectbluefin/bluefin/blob/main/Containerfile)
- [Universal Blue Homebrew](https://github.com/ublue-os/brew)
