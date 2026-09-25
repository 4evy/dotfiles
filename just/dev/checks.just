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

# Validate the locked Python project with the same checks locally and in CI.
[group('check')]
python-check: python-lint python-complexity python-dead-code python-dependencies python-typecheck
    uv lock --check
    uv sync --check
    bytecode_dir=$(mktemp -d)
    build_dir=$(mktemp -d)
    trap 'rm -rf "$bytecode_dir" "$build_dir"' EXIT
    PYTHONPYCACHEPREFIX="$bytecode_dir" uv run python -m compileall -q -x /node_modules/ .github ansible bluebuild dotfiles packages
    uv build --out-dir "$build_dir" --no-build-logs

[group('check')]
python-lint:
    uv run ruff check .

# Check declared dependencies against first-party imports.
[group('check')]
python-dependencies:
    uv run deptry

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

_check-ansible: (doctor 'ansible') _deps (_run-files 'uv' ['*.yaml', '*.yml'] ['run', 'yamllint'])
    uv run ansible-playbook --syntax-check ansible/site.yml
    uv run ansible-lint ansible

[group('check')]
github-actions-check:
    actionlint
    zizmor --persona=pedantic .github/workflows .github/actions

[group('check')]
bun-check: (doctor 'bun')
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

[group('check')]
ruby-check:
    bundle exec rubocop
    for file in {{ quote(git_files(['*.rb', 'Brewfile', 'Gemfile'])) }}; do
      [[ -f $file && ! -L $file ]] || continue
      ruby -c "$file" >/dev/null
    done

# Discover modules from go.work so adding a module also adds its checks.
[group('check')]
go-check:
    workspace=$(go work edit -json)
    module_paths=$(jq -er '.Use[].DiskPath' <<< "$workspace")
    modules=()
    while IFS= read -r module; do
      modules+=("$module/...")
      unformatted=$(find "$module" -type f -name '*.go' -exec gofmt -l {} +)
      if [[ -n $unformatted ]]; then
        printf 'Go files need formatting:\n%s\n' "$unformatted" >&2
        exit 1
      fi
    done <<< "$module_paths"
    go test "${modules[@]}"
    go vet "${modules[@]}"
    golangci-lint run "${modules[@]}"
    CGO_ENABLED=0 go build -o /dev/null ./packages/theme-run/cmd/theme-run

[group('dev')]
bun-install:
    bun install --frozen-lockfile
    bun install --cwd packages/hyper-window-tiling --frozen-lockfile

# Build the same source archive used by the local Homebrew tap.
[group('dev')]
homebrew-source output='Sources/theme-run-0.1.0.tar':
    bash scripts/package-theme-run.sh {{ quote(output) }}

[group('check')]
homebrew-check: homebrew-source
    brew style Formula/*.rb
    brew bundle list --file Brewfile --all >/dev/null

[group('check')]
renovate-check:
    bun install --cwd .github/renovate --frozen-lockfile
    bun run --cwd .github/renovate validate
    bun run --cwd .github/renovate extract

# Lint repository source files and run project validation.
_lint-deps: bun-install
    bundle install

# Run formatting, dependency, and source validation.
[group('check')]
lint: (doctor 'lint') check-format _lint-deps _check-ansible _lint-checks

[parallel]
_lint-checks: _lint-files python-check github-actions-check bun-check go-check ruby-check

# Evaluate every flake output without building package derivations.
[group('check')]
nix-check: (doctor 'fmt')
    nix flake check --all-systems --keep-going --no-build --no-eval-cache

# Run the repo validation suite.
[group('check')]
check: lint nix-check

# Match the current runner rather than duplicating its Nix system in workflows.
nix_system := shell('nix eval --impure --raw --expr builtins.currentSystem')

# Evaluate the system configuration before the flake's import-from-derivation
# checks, then build the repository lint and formatting checks.
[group('check')]
nix-ci-check:
    nix eval --raw .#nixosConfigurations.nixos.config.system.build.toplevel.drvPath >/dev/null
    nix flake check --keep-going --no-build
    nix build --keep-going --print-build-logs \
      .#checks.{{ nix_system }}.pre-commit .#checks.{{ nix_system }}.treefmt

# Exclude the complete OS build and the repository checks already run above.
# Discover package checks from the flake instead of keeping a list in YAML.
[group('check')]
nix-native-checks:
    nix eval --json .#checks.{{ nix_system }} --apply builtins.attrNames | \
      jq -c 'map(select(. != "pre-commit" and . != "treefmt" and . != "nixos"))'

[group('check')]
nix-build-check name:
    nix build --print-build-logs {{ quote('.#checks.' + nix_system + '.' + name) }}
