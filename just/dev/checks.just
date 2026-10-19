_check-yaml: (_run-files 'yamllint' ['*.yaml', '*.yml'])

# Lint repository source files and run project validation.
_lint-deps: bun::install

# Run formatting, dependency, and source validation.
[group('check')]
lint: (_doctor 'lint') check::format _lint-deps _check-yaml _lint-checks

[parallel]
_lint-checks: _lint-files python::check github::actions::check bun::check go::check
