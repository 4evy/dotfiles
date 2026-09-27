#!/usr/bin/env -S just --justfile

set minimum-version := "1.58.0"
set unstable
set lists
set lazy
set default-list
set default-script
set shell := ['bash', '-euo', 'pipefail', '-c']
set script-interpreter := ['bash', '-euo', 'pipefail']

# Recipe shells must keep this file's PATH instead of reloading shell startup
unexport BASH_ENV

import 'just/dev.just'
import 'just/secrets.just'
import 'just/setup.just'
import 'just/spectrum.just'
import 'just/system.just'

podman := split(env("PODMAN", "podman"))

host_os := os()
repo_dir := justfile_directory()
[private]
just_command := quote([just_executable(), "--justfile", justfile()])

homebrew_prefix := env("HOMEBREW_PREFIX", if host_os == "macos" { "/opt/homebrew" } else { "/home/linuxbrew/.linuxbrew" })
homebrew_gnu_formulae := ['coreutils', 'findutils', 'gnu-sed', 'grep', 'gawk', 'gnu-tar', 'gnu-which', 'diffutils', 'make']
homebrew_gnu_path := if host_os == "macos" { homebrew_prefix / "opt" / homebrew_gnu_formulae / "libexec/gnubin" }
homebrew_path := homebrew_prefix / ["bin", "sbin"]
nix_bin_dir := "/nix/var/nix/profiles/default/bin"
nix_profile_bin_dir := home_directory() / ".nix-profile/bin"
nixos_profile_bin_dir := "/run/current-system/sw/bin"

# Keep activated runtimes ahead of fallback tools; add GNU utilities locally
# since CI already supplies the selected tools
export PATH := if env("CI", "") == "true" { env("PATH", "") } else { join_list([homebrew_gnu_path, env("PATH", ""), homebrew_path, nix_bin_dir, nix_profile_bin_dir, nixos_profile_bin_dir], PATH_VAR_SEP) }
# Development recipes are reproducible by default; dependency changes must be
# made explicitly with uv outside the task runner
export UV_LOCKED := "1"

alias a := apply
[linux]
alias build := spectrum-build
alias c := check
alias cf := check-format
alias ck := check
alias diff := dotfiles-diff
alias f := fmt
alias h := help
alias l := lint
alias nx := nix
[linux]
alias r := reboot
alias s := setup
alias typecheck := python-typecheck
alias up := update
[linux]
alias validate := spectrum-validate
alias w := watch

# List recipes or show detailed usage for one recipe
[arg('recipe', help='Recipe to explain; omit to list all recipes')]
[group('system')]
help recipe='':
    {{ just_command }} \
      {{ quote(if recipe != '' { ['--usage', recipe] } else { ['--list', '--list-submodules'] }) }}
