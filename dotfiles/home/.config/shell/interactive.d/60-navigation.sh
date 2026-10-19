#                                                                       ⢯⣭⠇
#                                                                   ⢀⡤⣶⡮⢽⢿⠭⣶⡦⣄
#                                                                  ⡴⡿⠏⠁ ⣸⣹⡀ ⠉⠿⡷⡄
#         ⢀⣀⣀⣀⣀⣀⣀⣀⣀                                               ⡸⡿⠁   ⡇⢌⡇   ⠹⡿⡀
#         ⢸       ⠈⢣⡀                                            ⠤⣷⣗⣒⣚⠋⠙⣻⣾⡋⢍⢹⣒⣖⣷⡧⠄
#         ⢸ ⢰⠒⠒⠒⠒⠒⠒⠒⠛⠛⠛⠛⠛⠛⠛⠛⠛⡏⠉⢹                                  ⢣⣧ ⠈⠉⠉⡯⠈⡏⠉⠉⣰⣯⣧⠃
#         ⢸ ⠈⢰⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⢹⠉⢩⠇                               ⠈⢯⣧⡄  ⢳⢰⠃⣠⣾⣿⣯⠏
#         ⢸ ⢠⠇        ⢰⣇       ⢸ ⡜                                  ⠙⠯⣷⡦⢼⣼⠤⣿⡯⠟⠁
#         ⢸ ⡞       ⠐⠛⢯⡼⠛⠃     ⢸⢰⠁                                     ⠈⠉⠏⠉
#         ⢸⡸          ⠘⠃       ⢸⡏
#         ⠸⣧⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⡼
#
#                                          ⣀⣀⣀⣀⣀⣀⣀⣀⡀
#                                          ⡇       ⠙⣄
#                                          ⡇ ⡖⠒⠒⠒⠒⠒⠒⠚⠛⠛⠛⠛⠛⠛⠛⠛⢻⠉⠉⡇
#                                          ⡇ ⠁⡎⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⡏⠉⡽
#                                          ⡇ ⡼                  ⡇⢠⠃
#                                          ⡇⢰⠃                  ⡇⡎
#                                          ⣇⠇  ⠐⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠂   ⣿⠁
#                                          ⢿⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⠇

# C2 / yazi
# Follow the directory selected by yazi when it exits.

yy() {
	local tmp cwd='' cmd_status

	tmp="$(mktemp -t "yazi-cwd.XXXXX")" || return
	yazi "$@" --cwd-file="$tmp"
	cmd_status=$?
	# Read through EOF without stripping newlines that belong to the directory
	if IFS= read -r -d '' cwd <"$tmp" || [[ -n "$cwd" ]]; then
		if [[ -n "$cwd" && "$cwd" != "$PWD" ]]; then
			builtin cd -- "$cwd" || cmd_status=$?
		fi
	fi
	rm -f -- "$tmp"

	return "$cmd_status"
}

# C3 / Python via uv
# Route Python through uv and create a virtual environment for pip when needed.

python() { uv run python "$@"; }
python3() { uv run python3 "$@"; }

pip() {
	if [[ -z "${VIRTUAL_ENV:-}" && ! -d .venv ]]; then
		uv venv -q || return
	fi
	uv pip "$@"
}

pip3() {
	pip "$@"
}

# C4 / fzf palette
# `theme-run fzf` supplies the matching option file.
