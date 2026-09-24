[private]
export SOPS_CONFIG := env("SOPS_CONFIG", repo_dir / ".sops.yaml")
[macos]
[private]
export SOPS_AGE_KEY_CMD := env("SOPS_AGE_KEY_CMD", repo_dir / "dotfiles/dot_local/bin/executable_sops-age-key-1password")
[private]
sops_records_vault := repo_dir / "secrets/records.yaml"
[private]
sops_settings_vault := repo_dir / "secrets/secrets.yaml"
[private]
sops_vaults := [sops_records_vault, sops_settings_vault]

# Materialize records at their chezmoi source paths, or pass an external workspace.
[arg('workspace', max='1', help='Optional protected workspace outside the repository')]
[group('secrets')]
records-unpack *workspace: (_records ['unpack', workspace])

# Re-encrypt materialized records, or pass an external protected workspace.
[arg('workspace', max='1', help='Optional protected workspace outside the repository')]
[group('secrets')]
records-pack *workspace: (_records ['pack', workspace])

# Validate the encrypted vault, or pass a protected workspace to validate it.
[arg('workspace', max='1', help='Optional protected workspace outside the repository')]
[group('secrets')]
records-check *workspace: (_records ['check', workspace])

# Materialize and edit the source tree, or open one target or source path.
[arg('target', max='1', help='Optional record target or chezmoi source path')]
[group('secrets')]
records-edit *target: (_records ['edit', target])

# Decrypt and show target-to-source record mappings and attributes.
[group('secrets')]
records-layout: (_records ['layout'])

# Decrypt and validate every SOPS vault.
[group('secrets')]
sops-check: records-check (_sops-decrypt sops_settings_vault)

# Refresh the SOPS master-key metadata for every encrypted vault.
[group('secrets')]
sops-updatekeys: (doctor 'sops')
    sops updatekeys --yes {{ quote(sops_vaults) }}

[env('SOPS_AGE_KEY_CACHE', 'records')]
_records +args: (doctor 'records')
    go run ./packages/records/cmd {{ quote(args) }}

_sops-decrypt vault:
    sops filestatus {{ quote(vault) }} | jq -e '.encrypted == true' >/dev/null
    sops decrypt --output /dev/null {{ quote(vault) }}
