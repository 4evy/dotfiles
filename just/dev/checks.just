[private]
_run executable +arguments:
    printf '==> %s\n' {{ quote(join_list([executable, arguments])) }}
    {{ quote(require(executable)) }} {{ quote(arguments) }}

[private]
_run-files executable patterns arguments=[]:
    printf '==> %s\n' {{ quote(join_list([executable, arguments])) }}
    : {{ quote(assert(patterns, '_run-files requires at least one file pattern')) }}
    files=()
    while IFS= read -r -d '' file; do
      [[ -f $file && ! -L $file ]] && files+=("$file")
    done < <(git ls-files -z --cached --others --exclude-standard -- {{ quote(patterns) }})
    ((${#files[@]} == 0)) || {{ quote(require(executable)) }} {{ quote(arguments) }} "${files[@]}"

[private]
_check-python: python-complexity python-dead-code python-dependencies python-typecheck
    uv lock --check
    uv sync --check
    bytecode_dir=$(mktemp -d)
    build_dir=$(mktemp -d)
    trap 'rm -rf "$bytecode_dir" "$build_dir"' EXIT
    PYTHONPYCACHEPREFIX="$bytecode_dir" uv run python -m compileall -q ansible dotfiles packages
    uv build --out-dir "$build_dir" --no-build-logs

# Check declared dependencies against first-party imports.
[group('check')]
python-dependencies:
    uv run deptry .

# Type-check the Python source roots configured in pyproject.toml.
[arg('args', help='Arguments forwarded to ty check')]
[group('check')]
python-typecheck *args:
    uv run ty check {{ quote(args) }}

# Scan the first-party Python source roots configured in pyproject.toml.
[group('check')]
python-dead-code:
    uv run vulture

# Reject cognitively complex functions in the configured Python source roots.
[group('check')]
python-complexity:
    uv run complexipy --plain

[private]
_check-ansible: (doctor 'ansible') _deps (_run-files 'yamllint' ['*.yaml', '*.yml'])
    ansible-playbook --syntax-check ansible/site.yml
    ansible-lint ansible

[private]
_check-github-actions:
    actionlint
    zizmor --persona=pedantic .github/workflows .github/actions

[private]
_check-bun: (doctor 'bun')
    bun run check

# Check Hyper Window Tiling's Bun Nix expression against its lockfile.
[group('check')]
bun-nix-check:
    generated=$(nix run .#bun2nix -- \
      --lock-file packages/hyper-window-tiling/bun.lock \
      --copy-prefix packages/hyper-window-tiling)
    if ! diff -u \
      packages/hyper-window-tiling/bun.nix \
      <(printf '%s\n' "$generated"); then
      printf 'packages/hyper-window-tiling/bun.nix is stale; run `just bun-nix-update`.\n' >&2
      exit 1
    fi

# Update Hyper Window Tiling's Bun Nix expression from its lockfile.
[group('dev')]
bun-nix-update:
    nix run .#bun2nix -- \
      --lock-file packages/hyper-window-tiling/bun.lock \
      --copy-prefix packages/hyper-window-tiling \
      --output-file packages/hyper-window-tiling/bun.nix
    nix fmt -- packages/hyper-window-tiling/bun.nix

[private]
_check-ruby:
    bundle exec rubocop
    while IFS= read -r -d '' file; do
      [[ -f $file && ! -L $file ]] || continue
      ruby -c "$file" >/dev/null
    done < <(git ls-files -z --cached --others --exclude-standard -- '*.rb' Brewfile Gemfile)

[private]
_check-go:
    go test ./... ./packages/theme-run/...
    go vet ./... ./packages/theme-run/...
    golangci-lint run ./... ./packages/theme-run/...
    CGO_ENABLED=0 go build -o /dev/null ./packages/theme-run/cmd/theme-run

# Lint repository source files and run project validation.
[private]
_lint-deps:
    bundle install
    bun install --frozen-lockfile
    bun install --cwd packages/hyper-window-tiling --frozen-lockfile

# Run formatting, dependency, and source validation.
[group('check')]
lint: (doctor 'lint') check-format _lint-deps _check-ansible _lint-checks

[parallel]
[private]
_lint-checks: _lint-files _check-python _check-github-actions _check-bun _check-go _check-ruby

# Evaluate every flake output without building package derivations.
[group('check')]
nix-check: (doctor 'fmt')
    nix flake check --all-systems --keep-going --no-build --no-eval-cache

# Run the repo validation suite.
[group('check')]
check: lint nix-check
