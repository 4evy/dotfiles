#!/bin/sh
# shellcheck shell=sh

set -eu

readonly program="${0##*/}"
readonly recipient='age1kc4gmk6jztv6schw3mhwwea7nn8emce4uwqufawfwapv9tlgdazqz7fc2w'
readonly item_reference='op://Personal/SOPS-age-identity/password'
readonly cache_environment='records'
readonly read_attempts=3
readonly retry_delay=2

require_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		printf '%s: %s is not installed\n' "$program" "$2" >&2
		exit 127
	fi
}

# SOPS calls this command once for each age recipient it cannot otherwise
# satisfy. Return nothing for unrelated recipients so other key sources and
# key groups can continue to work normally.
if [ -n "${SOPS_AGE_RECIPIENT:-}" ] &&
	[ "$SOPS_AGE_RECIPIENT" != "$recipient" ]; then
	exit 0
fi

case "${1:-}" in
	--clear | --status)
		mode=cache
		;;
	*)
		mode=direct
		;;
esac
if [ "${SOPS_AGE_KEY_CACHE:-}" = "$cache_environment" ]; then
	mode=cache
fi

if [ "$mode" = cache ]; then
	require_command python3 Python
	cache_helper=${0%/*}/cache.py
	if [ ! -f "$cache_helper" ]; then
		cache_helper=${0%/*}/../lib/sops/cache.py
	fi
	if [ ! -f "$cache_helper" ]; then
		printf '%s: cache helper is not installed\n' "$program" >&2
		exit 127
	fi

	exec python3 "$cache_helper" "$@"
fi

require_command op '1Password CLI'

attempt=1
while [ "$attempt" -le "$read_attempts" ]; do
	if identity=$(op read "$item_reference"); then
		printf '%s\n' "$identity"
		exit 0
	fi

	if [ "$attempt" -lt "$read_attempts" ]; then
		sleep "$retry_delay"
	fi
	attempt=$((attempt + 1))
done

exit 1
