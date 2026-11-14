# shellcheck shell=bash
# Sandboxed checks validate the public tree without access to decryption keys
if [[ -n ${DOTFILES_TREEFMT_RECORDS:-} ||
	(-n ${NIX_BUILD_TOP:-} && -z ${IN_NIX_SHELL:-}) ]]; then
	exit 0
fi

if ! repository_root=$(git rev-parse --show-toplevel 2>/dev/null); then
	exit 0
fi
cd "$repository_root" || exit 1
git_directory=$(git rev-parse --git-common-dir)
exec 9>"$git_directory/treefmt-records.lock"
flock 9

record_options=()
for argument in "$@"; do
	[[ $argument == . ]] || record_options+=("$argument")
done

records_ready=0
pack_records() {
	exit_status=$?
	trap - EXIT
	if ((records_ready)); then
		if ! just records pack >/dev/null 2>&1; then
			printf 'Failed to repack encrypted records; plaintext remains materialized.\n' >&2
			exit 1
		fi
		if ((exit_status == 0)); then
			printf 'Encrypted records formatted and repacked.\n'
		fi
	fi
	exit "$exit_status"
}
trap pack_records EXIT

if [[ -f .records-unpacked ]]; then
	records_ready=1
elif just records unpack >/dev/null 2>&1; then
	records_ready=1
else
	printf 'Skipping encrypted records because they could not be unpacked.\n' >&2
	exit 0
fi

record_paths=()
git_exclude=$(git rev-parse --git-path info/exclude)
while IFS= read -r path; do
	path=${path#/}
	[[ -f $path && ! -L $path ]] && record_paths+=("$path")
done < <(
	awk '
    /^# BEGIN dotfiles encrypted records$/ { copy = 1; next }
    /^# END dotfiles encrypted records$/ { copy = 0 }
    copy { print }
  ' "$git_exclude"
)

if ((${#record_paths[@]})); then
	# Formatter diagnostics can contain private source snippets
	if ! DOTFILES_TREEFMT_RECORDS=1 nix fmt -- "${record_options[@]}" "${record_paths[@]}" >/dev/null 2>&1; then
		printf 'Encrypted record formatting failed; repacking the records.\n' >&2
		exit 1
	fi
fi
