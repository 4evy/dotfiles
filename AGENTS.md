# Dotfiles

Edit this guide only with explicit permission.

## Nix conventions

- Prefer namespaced Nixpkgs `lib` helpers over aliases or equivalent `builtins`.
  Bind names explicitly. Never use `with` or `rec`. Prefer `finalAttrs` for
  derivation attributes that refer to each other and `let … in` elsewhere.
- Use `lib.meta.getExe` for a package's main program and `lib.meta.getExe'` for
  a named binary. Use `symlinkJoin` to merge trees and `linkFarm` for named
  links.
- Prefer `writeShellApplication` for Bash and `pkgs.writers.writePython3Bin` for
  Python commands. Give new packages a `passthru.updateScript` when possible.
- Document custom functions with a Nixpkgs-style `/** … */` above the binding:
  inputs, defaults, type signature, and a call with its result.
- Run `deadnix` on changed Nix files and build the affected output. For shared
  home-renderer changes, `just hjem check` covers Darwin, Fedora, and NixOS.

## Home files and records

- **Hjem:** edit `home/files/` and its mappings in `home/manifest.nix`, not
  installed files. Preview with `just dotfiles diff` on the affected host.
  `just apply` activates the whole generation. Check the destination and diff
  afterward. For renames or removals, verify Hjem owned and removed the old
  target. Leave unmanaged files alone.
- **Records:** keep private guidance encrypted and track public config normally.
  Use `just records edit [path]` or `just records unpack`, edit `home/records/`,
  then `just records pack`. Validate with `just records check`. Never hand-edit
  `secrets/records.yaml`. After recipient changes, run `just sops updatekeys`.
- **Plaintext:** deploy private files outside the checkout and Nix store and
  link them through Hjem. Use `just records layout` only for mappings. Never
  commit plaintext or layout. `jj diff` decrypts records: don't paste or save
  it. Use `jj ds` for stats and `records: update` with no body for the commit.
