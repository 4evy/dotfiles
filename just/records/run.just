[env('SOPS_AGE_KEY_CACHE', 'records')]
_records +args: (_doctor 'records')
    bun tools/records/main.ts {{ quote(args) }}
