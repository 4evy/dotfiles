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
