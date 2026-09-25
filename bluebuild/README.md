# Spectrum

Run `just spectrum-build` from the repository root. It prepares the generated
recipe and source inputs before calling BlueBuild.

- Use bootc for image updates so `/usr/lib/bootc/kargs.d` arguments apply.
- Keep Bluefin's bundled Homebrew setup. The BlueBuild `brew` module replaces
  its payload and services. Brew updates here are manual: `just update`.
- A shared module `source` image overrides the version in `type`, so it can
  silently run a different implementation than the recipe names.
- Use `script@v2` for multiline snippets. Version 1 splits them into separate
  commands, breaking heredocs and shell control flow.
- Validate with `just spectrum-validate`: the CLI validator selects the v1
  schema, but these recipes use v2.
