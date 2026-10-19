#!/usr/bin/env -S just --justfile

import 'just/common.just'
import 'just/sops/vaults.just'
import 'just/dev/dev.just'
import 'just/setup/setup.just'
import 'just/system/system.just'

set default-list

mod bun 'just/bun/bun.just'
mod check 'just/check/check.just'
mod determinate 'just/determinate/determinate.just'
mod dotfiles 'just/dotfiles/dotfiles.just'
mod github 'just/github/github.just'
mod go 'just/go/go.just'
mod hjem 'just/hjem/hjem.just'
mod homebrew 'just/homebrew/homebrew.just'
mod just 'just/just/just.just'
mod nix 'just/nix/nix.just'
mod python 'just/python/python.just'
mod records 'just/records/records.just'
mod renovate 'just/renovate/renovate.just'
mod sops 'just/sops/sops.just'
mod spectrum 'just/spectrum/spectrum.just'

alias a := apply
[linux]
alias build := spectrum::build
alias c := check
alias cf := check::format
alias ck := check
alias diff := dotfiles::diff
alias f := fmt
alias h := help
alias l := lint
alias nx := nix
[linux]
alias r := reboot
alias s := setup
alias typecheck := python::typecheck
alias up := update
[linux]
alias validate := spectrum::validate
alias w := watch

# List recipes or show detailed usage for one recipe
[arg('recipe', help='Command and subcommands to explain, or omit to list commands')]
[group('system')]
help *recipe:
    {{ just_command }} \
      {{ quote(if recipe != [] { ['--usage', recipe] } else { ['--list', '--list-submodules'] }) }}

# Check one workflow's commands, or every workflow when omitted
[arg('profile', pattern=['status', 'reboot', 'install', 'build', 'setup', 'reconcile', 'apply', 'records', 'sops', 'shell', 'spectrum', 'fmt', 'lint', 'bun', 'nix', 'watch', 'check', 'all'], help='Workflow to check')]
[group('system')]
doctor $profile="all": (_doctor profile)
