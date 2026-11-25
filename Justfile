#!/usr/bin/env -S just --justfile

import 'just/common.just'
import 'just/sops/vaults.just'
import 'just/check/lint.just'

set default-list

mod bun 'just/bun/bun.just'
mod check 'just/check/check.just'
mod determinate 'just/determinate/determinate.just'
mod dev 'just/dev/dev.just'
mod dotfiles 'just/dotfiles/dotfiles.just'
mod github 'just/github/github.just'
mod hjem 'just/hjem/hjem.just'
mod homebrew 'just/homebrew/homebrew.just'
mod just 'just/just/just.just'
mod nix 'just/nix/nix.just'
mod records 'just/records/records.just'
mod renovate 'just/renovate/renovate.just'
mod setup 'just/setup/setup.just'
mod sops 'just/sops/sops.just'
mod spectrum 'just/spectrum/spectrum.just'
mod system 'just/system/system.just'

alias a := dotfiles::apply
# Keep the activation shortcut documented in AGENTS.md
alias apply := dotfiles::apply
[linux]
alias build := spectrum::build
alias c := check
alias cf := check::format
alias ck := check
alias diff := dotfiles::diff
alias f := dev::fmt
alias l := check::lint
alias nx := nix
[linux]
alias r := system::reboot
alias s := setup::run
alias up := setup::update
[linux]
alias validate := spectrum::validate
alias w := dev::watch
