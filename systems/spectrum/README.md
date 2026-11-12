# Spectrum

Run from the repository root:

```bash
just spectrum validate
just spectrum build   # Build only
just spectrum switch  # Build and stage, or `rebuild` in an interactive shell
```

Recipe: [`recipes/spectrum.yml`](recipes/spectrum.yml)

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
- Keep Bluefin's bundled Homebrew setup. The BlueBuild `brew` module replaces it.
  Update Brew manually with `just update`
- Use the locked Nixpkgs unstable `bluebuild` package for local tooling and CI.
  The upstream overlay retains only switch-validation and driver-selection fixes
- A shared module `source` image overrides the version in `type`
- Use `script@v2` for multiline snippets. Version 1 splits shell control flow
- Keep the digest-pinned `main-installer`. Release installers lack `bootc` and
  `recipe-v2`
- Use `just spectrum validate` for v2 recipes. The CLI validator selects v1

## CI caching

The [build preparation](../../.github/actions/spectrum/prepare/action.yaml)
installs [runner-only storage options](../../.github/actions/spectrum/build/storage.conf)
before Podman's first probe. Keep native overlay diffs enabled so committing a
small change does not scan the entire Bluefin filesystem. These options do not
change workstation storage

Spectrum reuses registry layers and its runtime-tooling archive. Nix check jobs
use a separate [build-output archive](../../.github/actions/setup/nix/action.yaml)
instead of per-path GitHub cache requests. The
[export recipe](../../just/nix/ci.just) retains unsigned build outputs, including
intermediate compiler artifacts, while signed dependencies come from upstream
binary caches
