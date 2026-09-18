[private]
sops_config := env("SOPS_CONFIG", repo_dir / ".sops.yaml")
[private]
sops_age_key_command := env("SOPS_AGE_KEY_CMD", repo_dir / "dotfiles/dot_local/bin/executable_sops-age-key-1password")
[private]
sops_environment := ['env', 'SOPS_CONFIG=' + sops_config] ++ (if host_os == "macos" { ['SOPS_AGE_KEY_CMD=' + sops_age_key_command] } else { [] })
[private]
sops_command := sops_environment ++ ['sops']
[private]
sops_records_vault := repo_dir / "secrets/records.yaml"
[private]
sops_settings_vault := repo_dir / "secrets/secrets.yaml"
[private]
sops_vaults := [sops_records_vault, sops_settings_vault]
[private]
records_command := sops_environment ++ ['SOPS_AGE_KEY_CACHE=records', 'go', 'run', './packages/records/cmd']

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
    {{ quote(sops_command ++ ['updatekeys', '--yes', sops_vaults]) }}

[private]
_records +args: (doctor 'records')
    {{ quote(records_command ++ args) }}

[private]
_sops-decrypt vault:
    {{ quote(sops_command ++ ['filestatus', vault]) }} | jq -e '.encrypted == true' >/dev/null
    {{ quote(sops_command ++ ['decrypt', '--output', '/dev/null', vault]) }}
