[parallel]
_lint-files: _check-worktree-paths _lint-hjem-source (_run-files 'jq' ['*.json', 'flake.lock', ':(exclude).vscode/settings.json'] ['empty']) _lint-container-files (_run-files 'luacheck' ['*.lua']) (_run 'rumdl' ['check', '--respect-gitignore', '.']) _lint-nix _lint-shell-files _lint-input-templates (_run-files 'taplo' ['*.toml'] ['lint']) _lint-xml

[linux]
_lint-container-files: (_run-files 'hadolint' ['Dockerfile', 'Containerfile'])

[macos]
_lint-container-files:

_check-worktree-paths:
    broken=0
    for file in {{ quote(git_files([])) }}; do
      if [[ -L $file && ! -e $file ]]; then
        target=$(readlink "$file")
        if [[ $file == bluebuild/files/system/* && $target == /* && -e bluebuild/files/system$target ]]; then
          continue
        fi
        printf 'broken symlink: %s\n' "$file" >&2
        broken=1
      elif [[ ! -e $file ]]; then
        printf 'tracked path missing from worktree: %s\n' "$file" >&2
      fi
    done
    exit "$broken"

# Render every supported host variant and validate the generated home files
[group('check')]
hjem-check: sops-check *(_hjem-platform *['darwin', 'fedora', 'nixos'])

_lint-hjem-source: hjem-check

_hjem-platform platform:
    bun scripts/check/hjem.ts {{ quote(platform) }}
