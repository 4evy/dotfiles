import 'repository.just'
import 'source.just'

_check-yaml: (_run-files 'yamllint' ['*.yaml', '*.yml'])

# Run sibling validators in one dependency graph
_lint: (_doctor 'lint') check::format bun::install _check-yaml _lint-checks

[parallel]
_lint-checks: _lint-files github::actions::check bun::check
