[parallel]
_lint-files: _check-worktree-paths _lint-chezmoi-source (_run-files 'jq' ['*.json', 'flake.lock', ':(exclude).vscode/settings.json'] ['empty']) _lint-container-files (_run-files 'luacheck' ['*.lua']) (_run 'rumdl' ['check', '--respect-gitignore', '.']) _lint-nix _lint-shell-files _lint-input-templates (_run-files 'taplo' ['*.toml'] ['lint']) _lint-xml

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

# Render each platform once and validate chezmoi's structured target state
[group('check')]
chezmoi-check: sops-check *(_chezmoi-platform *['darwin', 'fedora', 'nixos', 'windows'])

_lint-chezmoi-source: chezmoi-check

_chezmoi-platform platform:
    uv run python packages/chezmoi-check/check.py {{ quote(platform) }}
