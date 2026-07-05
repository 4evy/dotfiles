#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

script_dir=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

# shellcheck source=../../ansible/files/scripts/host/lib/entrypoint.sh
source -p "$script_dir/../../ansible/files/scripts/host/lib" entrypoint.sh
source_host_lib fs

app_id=${SUSHI_PREVIEW_APP_ID:-org.gnome.NautilusPreviewer}
build_profile=${SUSHI_PREVIEW_PROFILE:-default}
source_rev=${SUSHI_PREVIEW_REV:-127eb8e45115d257c6bb0254b4f2e5f37bc7233d}
source_url=${SUSHI_PREVIEW_REPO:-https://github.com/GNOME/sushi.git}

cache_root=${XDG_CACHE_HOME:-$HOME/.cache}/dotfiles/sushi-preview-flatpak
source_dir=$cache_root/source
build_dir=$cache_root/build
builder_state_dir=$cache_root/flatpak-builder-state
manifest_file=$source_dir/flatpak/org.gnome.NautilusPreviewer.json
stamp_dir=${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles
stamp_file=$stamp_dir/sushi-preview-flatpak.stamp

update_manifest() {
	local manifest_file=$1

	jq \
		--arg app_id "$app_id" \
		--arg profile "$build_profile" \
		'
      def set_sushi_profile:
        if any(.[]; startswith("-Dprofile=")) then
          map(if startswith("-Dprofile=") then "-Dprofile=\($profile)" else . end)
        else
          . + ["-Dprofile=\($profile)"]
        end;

      ."app-id" = $app_id
      | (.modules[] | select(.name == "sushi") | ."config-opts") |= set_sushi_profile
    ' \
		"$manifest_file" | write_stdin_if_changed "$manifest_file" 0644
}

require_command flatpak git jq

stamp="rev=$source_rev app_id=$app_id profile=$build_profile"

flatpak override --user --env=GDK_GL=gles "$app_id" >/dev/null 2>&1 || true

if [[ -f $stamp_file ]] && [[ $(<"$stamp_file") == "$stamp" ]] && flatpak info --user "$app_id" >/dev/null 2>&1; then
	printf '%s\n' "$app_id is already installed from $source_rev with profile $build_profile"
	exit 0
fi

ensure_dir_mode 0755 "$cache_root" "$stamp_dir"

flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak remote-add --user --if-not-exists gnome-nightly https://nightly.gnome.org/gnome-nightly.flatpakrepo

flatpak install --user --noninteractive flathub org.flatpak.Builder
flatpak install --user --noninteractive gnome-nightly org.gnome.Platform//master org.gnome.Sdk//master
flatpak install --user --noninteractive flathub org.freedesktop.Sdk.Extension.rust-stable//25.08

if [[ -d $source_dir/.git ]]; then
	git -C "$source_dir" fetch --tags --prune --filter=blob:none origin
else
	remove_path "$source_dir"
	git clone --filter=blob:none --no-checkout -- "$source_url" "$source_dir"
fi

git -C "$source_dir" checkout --force --detach "$source_rev"
git -C "$source_dir" clean -fdx

update_manifest "$manifest_file"

flatpak run --filesystem="$cache_root" org.flatpak.Builder --user --install --force-clean --state-dir="$builder_state_dir" "$build_dir" "$manifest_file"

flatpak override --user --env=GDK_GL=gles "$app_id"
flatpak kill "$app_id" >/dev/null 2>&1 || true
if command -v nautilus >/dev/null 2>&1; then
	nautilus -q >/dev/null 2>&1 || true
fi

printf '%s\n' "$stamp" | write_stdin_if_changed "$stamp_file" 0644
printf '%s\n' "installed $app_id from $source_rev with profile $build_profile"
