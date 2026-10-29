_check-yaml: (_run-files 'yamllint' ['*.yaml', '*.yml'])

# Run formatting, dependency, and source validation.
[group('check')]
lint: (_doctor 'lint') check::format bun::install _check-yaml _lint-checks

[parallel]
_lint-checks: _lint-files github::actions::check bun::check
