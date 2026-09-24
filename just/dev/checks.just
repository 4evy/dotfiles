# Keep Git's NUL delimiters until conversion to a Just list, including newlines
# in filenames. shell() propagates discovery failures before a checker runs.
nul_split(output) := if output == '' { [] } else { split(trim_end_match(output, "\u{0}"), "\u{0}") }
git_files(patterns) := nul_split(shell('git ls-files -z --deduplicate --cached --others --exclude-standard -- ' + join_list(quote(patterns))))

[shell]
_run executable +arguments:
    {{ quote([executable, arguments]) }}

_run-files executable patterns arguments=[]:
    printf '==> %s\n' {{ quote(join_list([executable, arguments])) }}
    files=()
    for file in {{ quote(git_files(patterns)) }}; do
      [[ -f $file && ! -L $file ]] && files+=("$file")
    done
    ((${#files[@]} == 0)) || {{ quote([executable, arguments]) }} "${files[@]}"

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

_check-ansible: (doctor 'ansible') _deps (_run-files 'yamllint' ['*.yaml', '*.yml'])
    ansible-playbook --syntax-check ansible/site.yml
    ansible-lint ansible

_check-github-actions:
    actionlint
    zizmor --persona=pedantic .github/workflows .github/actions

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

_check-ruby:
    bundle exec rubocop
    for file in {{ quote(git_files(['*.rb', 'Brewfile', 'Gemfile'])) }}; do
      [[ -f $file && ! -L $file ]] || continue
      ruby -c "$file" >/dev/null
    done

_check-go:
    go test ./packages/records/... ./packages/theme-run/...
    go vet ./packages/records/... ./packages/theme-run/...
    golangci-lint run ./packages/records/... ./packages/theme-run/...
    CGO_ENABLED=0 go build -o /dev/null ./packages/theme-run/cmd/theme-run

# Lint repository source files and run project validation.
_lint-deps:
    bundle install
    bun install --frozen-lockfile
    bun install --cwd packages/hyper-window-tiling --frozen-lockfile

# Run formatting, dependency, and source validation.
[group('check')]
lint: (doctor 'lint') check-format _lint-deps _check-ansible _lint-checks

[parallel]
_lint-checks: _lint-files _check-python _check-github-actions _check-bun _check-go _check-ruby

# Evaluate every flake output without building package derivations.
[group('check')]
nix-check: (doctor 'fmt')
    nix flake check --all-systems --keep-going --no-build --no-eval-cache

# Run the repo validation suite.
[group('check')]
check: lint nix-check
