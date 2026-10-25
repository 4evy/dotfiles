# shellcheck shell=bash
# shellcheck disable=SC2154
#                                                           ⡤⣄⢠⠖⣆⢀⣀⡀
#                                                        ⢠⠤⣤⢇⣨⠭⠤⢬⣉⢠⡇
#                                                        ⢘⡆⣰⠋⠹⣄⣀⡼⠉⢳⡉⣩⠇
#                                                       ⠸⣍⡀⡧⠤⢼⠁ ⢹⠤⠤⡇⠓⢦
#                                                        ⡴⠃⢳⡀⢨⠗⠒⢯ ⣰⠃⣞⠉
#                                     ⢀⣠⠤⢤⣀              ⠉⠉⡷⠙⠻⠤⠤⠼⠛⡵⠦⠼
#         ⢠⠴⠒⠲⢤                       ⡞⢀⣤⡄⠘⡆               ⠓⠚⠙⣆⡼⠙⠦⠇
#         ⡏⠠⣶⣆⡈⡇                      ⢳⣔⠉⢁⣰⠃
#         ⠹⢤⣸⣠⠽⠓⠦⣄⡀                 ⢀⠔⠁⠈⠉⠉
#           ⢸     ⠉⠒⠤⣀            ⢀⠔⠁
#           ⢸         ⠉⠒⢤⣀   ⣀⣀⡀⢀⠔⠁
#           ⢸            ⠈⠙⢲⢯⣁⢀⠝⢧           ⢀⣀⢤⠏⠉⠓⠒⠢⠤⢤⣀⣀⡀     ⣀⣠⣠⠤⠤⠒⡖⠋⠉⢧⢄⣀
#           ⢸              ⠸⡄⠈⠳⣄⡼           ⢸ ⢸         ⠉⠉⠓⡖⠋⠉⠁⢸    ⡇  ⢸ ⢸
#           ⢸               ⠉⠓⠒⠋⢣⡀          ⢸ ⢸  ⠐⠤⠤⢄⣀⣀    ⡇   ⢸⣀⣀⠤⢤⠗  ⢸ ⢸
#           ⢸                    ⠙⢄         ⢸ ⢸        ⠉⠉  ⡇ ⠈⠉⢹   ⢸   ⢸ ⢸
#           ⢸                     ⠈⠳⡄       ⢸ ⡼  ⠐⠒⠒⠦⠤⢄⣀⣀  ⡇ ⢀⣀⣼⠤⠤⠖⢺⠒  ⠸⡄⢸
#           ⢸                       ⠈⢦⡀     ⢸ ⡇            ⡇   ⡇   ⢸    ⡇⢸
#         ⣰⠚⢹⠙⢲⡀                      ⢱⣴⠒⠲⢤ ⢸ ⡇  ⠈⠉⠑⠒⠒⠤⠤⠤  ⡇ ⠠⠤⡧⠔⢒⠒⡽⠉   ⡇⢸
#         ⣇ ⠘ ⢀⡇                      ⡏⠈⠳ ⠈⡇⢸ ⡇  ⢀⣀        ⡇   ⣧⠞⠉⠳⣇⣀   ⡇⢸
#         ⠘⠲⠤⠴⠚                       ⠹⢤⣀⣠⠼⠁⡸⢰⠃    ⠉⠉⠑⠒⠒⠤  ⡇ ⠠⠔⠒⠒⠉⠉⠁    ⢳⠸⡀
#                                           ⡇⢸ ⣀           ⡇          ⢀⡀⢸ ⡇
#                                           ⡇⠘⠒⠤⠭⣍⣓⡒⠦⠤⢤⣀⣀  ⡇ ⢀⣀⣠⠤⠤⠖⣒⣋⡭⠥⠔⠚ ⡇
#                                           ⠉⠉⠓⠒⠢⠤⢄⣉⣉⠑⠒⠢⠬⢥⣀⣇⣠⠭⠤⠒⠒⢉⣉⣁⠤⠤⠒⠒⠋⠉⠁
#                                                   ⠈⠉⠙⠒⠒⠦  ⠠⠖⠒⠚⠉⠉

# B3 / Brewfile
# Always use the repository Brewfile and report missing prerequisites clearly.

_dotfiles_brewfile="$_dotfiles_repo_path/Brewfile"

_dotfiles_brew_bundle() {
	if ! command -v brew >/dev/null 2>&1; then
		printf '%s\n' "brew is not installed" >&2
		return 127
	fi

	if [[ ! -f "$_dotfiles_brewfile" ]]; then
		printf '%s\n' "Brewfile not found: $_dotfiles_brewfile" >&2
		return 1
	fi

	command brew bundle --file "$_dotfiles_brewfile" "$@"
}

brewfile() {
	_dotfiles_brew_bundle "$@"
}

brewcheck() {
	_dotfiles_brew_bundle check --verbose "$@"
}

brewup() {
	_dotfiles_brew_bundle install --jobs auto --force-cleanup "$@"
}

# C1 / repository maintenance
# update applies userland state, rebuild provisions the host, and check runs
# syntax and lint validation.

update() (
	cd "$_dotfiles_repo_path" || exit
	just update "$@"
)

check() (
	cd "$_dotfiles_repo_path" || exit
	just check "$@"
)

if [[ $(uname -s) == Darwin ]]; then
	rebuild() {
		(
			cd "$_dotfiles_repo_path" &&
				just darwin "$@"
		)
	}

	micfix() {
		sudo killall coreaudiod "$@"
	}
else
	if [[ -e /etc/NIXOS ]]; then
		rebuild() {
			(
				cd "$_dotfiles_repo_path" &&
					sudo nixos-rebuild switch --flake .#nixos "$@"
			)
		}
	else
		rebuild() {
			(
				cd "$_dotfiles_repo_path" &&
					just spectrum switch "$@"
			)
		}
	fi

	micfix() {
		systemctl --user restart pipewire pipewire-pulse wireplumber "$@"
	}
fi
