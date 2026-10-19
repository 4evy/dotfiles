import '../common.just'
import 'vaults.just'

set working-directory := '../..'
set default-list
# Decrypt and validate every SOPS vault.
[group('secrets')]
check: _records-check (_sops-decrypt sops_settings_vault)

# Refresh the SOPS master-key metadata for every encrypted vault.
[group('secrets')]
updatekeys: (_doctor 'sops')
    sops updatekeys --yes {{ quote(sops_vaults) }}
_sops-decrypt vault:
    sops filestatus {{ quote(vault) }} | jq -e '.encrypted == true' >/dev/null
    sops decrypt --output /dev/null {{ quote(vault) }}

_records-check:
    {{ just_command }} records check
