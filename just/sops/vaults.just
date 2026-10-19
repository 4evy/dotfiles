[private]
export SOPS_CONFIG := env("SOPS_CONFIG", repo_dir / ".sops.yaml")
[macos]
[private]
export SOPS_AGE_KEY_CMD := env("SOPS_AGE_KEY_CMD", repo_dir / "dotfiles/home/.local/lib/sops/sops.sh")
[private]
sops_records_vault := repo_dir / "secrets/records.yaml"
[private]
sops_settings_vault := repo_dir / "secrets/secrets.yaml"
[private]
sops_vaults := [sops_records_vault, sops_settings_vault]
