# shellcheck shell=bash
# shellcheck disable=SC2154
#                                                  ⢠⢞⡭⣽⣶⣾⡭⣝⢦
#                                                  ⢸⡸⡤⣿⡛⣻⡧⡼⣸
#                                                   ⠳⣝⢿⣽⣽⢟⡵⠃
#                 ⣠⣖⣊⡉    ⠈⣉⣒⣦⡀                      ⠈⠳⣍⡵⠋
#               ⣠⡟⠋ ⢀⣉⡳⢄⢀⠴⣋⣁ ⠈⠛⣧⡀
#              ⢠⡿  ⡴⠋ ⢉⡻⡿⣋⠁⠈⠳⡄ ⠸⣧
#              ⢸⢳  ⣇  ⣼⣗⠳⣿⡄ ⢀⡇ ⢰⢻
#              ⠸⡌⢧ ⠘⣆ ⠹⣟⣞⡿⠁⢀⡞ ⢠⠏⡼
#               ⠳⡈⠳⡀⠈⠳⣄ ⠁⢀⡴⠋ ⡰⠋⡰⠃
#                ⠙⢦⣙⢦⡀⠈⠳⠴⠋ ⣠⢞⣡⠞⠁                     ⢀⣤⡶⠎⠉⠉⠶⣦⣄
#                  ⠈⠓⠯⠲⣄⢀⡴⠪⠗⠋                       ⣰⠋⠁⣠⠤⠒⠢⢤⡀⢉⣷⡀
#                      ⡌⠉⡄                         ⢰⣯⠙⡾⠁⢠⣶⣦ ⠹⡏⣶⢷
#                     ⢀⣇⣀⣇                        ⠘⢾⡭⠼⢧ ⢹⣯⣿⠁⢠⠟⠒⣾
#                    ⠸⢭⣇⣀⣯⠽                         ⢿⣄⠈⠳⢄⣈⣀⠴⠋⢀⣼⠇
#                     ⣀⣇⣀⣇⡀                          ⠙⢷⣦⠄  ⢤⣶⠟⠁
#                    ⠘⠧⡧⠤⡧⠟                             ⢹⠉⢹⠁
#                      ⡇ ⡇                              ⣾⣒⣺⡆
#                      ⡇ ⡇                              ⣼⠤⢼⡄
#                      ⡇ ⡇                              ⢹⠉⢹⠁
#                      ⡇ ⡧⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⡄                   ⢸ ⢸
#                      ⡇ ⡇      ⠤⠤⠤ ⡇                   ⢸ ⢸⣀⣀⣀⣀⣀⣀⣀
#                      ⡇ ⡇      ⠤⠤⠤ ⡇                   ⢸ ⢸    ⠤⠤⢸
#                      ⡇ ⡧⠤⠤⠤⠤⠤⡄    ⡇                   ⢸ ⢸    ⠉⠉⢸
#                      ⡇ ⡇     ⡇⠤⠤⠤ ⡇                   ⢸ ⢸⠉⠉⠉⡇⠤⠤⢸
#                    ⢠⠤⡗⠒⡧⢤    ⡇    ⡇                   ⢾⣉⣹⠆  ⠧⠤⠤⠼
#                    ⠈⠓⡗⠒⡗⠋    ⠉⠉⠉⠉⠉⠁                   ⠈ ⠈

# A4 / aliases and wrappers
# The shell-specific 20-core module sets _dotfiles_repo_path

alias oo="opencode"
alias hja='bun "$_dotfiles_repo_path/home/deploy/apply.ts" apply'
alias hjd='bun "$_dotfiles_repo_path/home/deploy/apply.ts" diff'
alias hjs='bun "$_dotfiles_repo_path/home/deploy/apply.ts" status'

# `op plugin init` owns this generated file. Keeping the source guarded makes
# shell-plugin aliases portable without making 1Password a shell startup
# dependency on machines where the CLI or plugin configuration is absent.
if [[ -r "$HOME/.config/op/plugins.sh" ]]; then
	# shellcheck disable=SC1091
	source "$HOME/.config/op/plugins.sh"
fi

# Compose optional theming and 1Password injection once instead of replacing
# one wrapper with another based on startup-time availability.
gh() {
	local -a gh_command=(gh)
	if command -v theme-run >/dev/null 2>&1; then
		gh_command=(theme-run gh)
	fi
	if command -v op >/dev/null 2>&1; then
		GH_TOKEN='op://Personal/GitHub Token/token' command op run -- "${gh_command[@]}" "$@"
	else
		command "${gh_command[@]}" "$@"
	fi
}

if command -v op >/dev/null 2>&1; then
	brew() {
		HOMEBREW_GITHUB_API_TOKEN='op://Personal/GitHub Token/token' command op run -- brew "$@"
	}
fi

pmclean() {
	if command -v podman >/dev/null 2>&1; then
		command podman system prune "$@"
	else
		printf '%s\n' "podman is not installed" >&2
		return 127
	fi
}
