# Spectrum

Run `just spectrum build` from the repository root to build only, or
`just spectrum switch` (`rebuild` in an interactive shell) to build and stage the
image. Both validate the recipe and source inputs before using the pinned
BlueBuild CLI in the operations shell.

- Use bootc for image updates so `/usr/lib/bootc/kargs.d` arguments apply.
- Keep Bluefin's bundled Homebrew setup. The BlueBuild `brew` module replaces
  its payload and services. Brew updates here are manual: `just update`.
- A shared module `source` image overrides the version in `type`, so it can
  silently run a different implementation than the recipe names.
- Use `script@v2` for multiline snippets. Version 1 splits them into separate
  commands, breaking heredocs and shell control flow.
- Validate with `just spectrum validate`: the CLI validator selects the v1
  schema, but these recipes use v2.
  The packaged CLI forwards `switch --skip-validation` to its internal generator
  so switching uses those schema checks instead of repeating v1 validation.
  Schema downloads, including remote `$ref` files, have 10-second connect and
  30-second read timeouts. The validator retains upstream's three attempts.
