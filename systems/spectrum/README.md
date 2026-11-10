# Spectrum

Run `just spectrum build` from the repository root to build only, or
`just spectrum switch` (`rebuild` in an interactive shell) to build and stage the
image. Both validate the recipe and source inputs before using the pinned
BlueBuild CLI in the operations shell.

The recipe lives in `systems/spectrum/recipes/spectrum.yml`. Image resources
retain their native `etc/` and `usr/` structure under `files/system/`.
Repository definitions live in `files/dnf/` and are staged under the DNF
module's `CONFIG_DIRECTORY` before native repository installation and cleanup.

The [`bun-dependencies` stage](recipes/spectrum/stages/bun-dependencies.yml)
installs the workstation and tiling workspace dependencies once. Both builders
inherit it. Keep source, palette, and extension metadata copies in the consumer
stages so those edits reuse the dependency layer.

The [`kanata` stage](recipes/spectrum/stages/kanata.yml) mounts only its source
locks, patch metadata, and build script. Keep changing inputs out of heavyweight
filesystem layers.

The [`spectrum-files` stage](recipes/spectrum/stages/files.yml) assembles builder
outputs and local configuration under `/out`. The final image copies that tree
once, after remote software installation. Add local image resources there
rather than adding another final-image `COPY`.

CI restores [all five runtime tools](../../.github/actions/spectrum/prepare/action.yaml)
from one Nix binary-cache archive before realizing them: Podman, Skopeo, Cosign,
the pinned CLI, and the schema validator. It saves changed closures before base
verification or image generation, so later failures do not discard the tooling.
Image layers remain in the existing GHCR cache. `RUN` cache mounts are local to
the builder and are not exported by the registry layer cache.

- Use bootc for image updates so `/usr/lib/bootc/kargs.d` arguments apply.
- Keep Bluefin's bundled Homebrew setup. The BlueBuild `brew` module replaces
  its payload and services. Brew updates here are manual: `just update`.
- A shared module `source` image overrides the version in `type`, so it can
  silently run a different implementation than the recipe names.
- Use `script@v2` for multiline snippets. Version 1 splits them into separate
  commands, breaking heredocs and shell control flow.
- The Nix package tracks released CLI sources with `bootc` and `recipe-v2`
  enabled. Upstream release installers omit those features, so the image
  deliberately retains a digest-pinned `main-installer` instead.
- Validate with `just spectrum validate`: the CLI validator selects the v1
  schema, but these recipes use v2.
  The packaged CLI forwards `switch --skip-validation` to its internal generator
  so switching uses those schema checks instead of repeating v1 validation.
  Schema downloads, including remote `$ref` files, have 10-second connect and
  30-second read timeouts. The validator retains upstream's three attempts.
