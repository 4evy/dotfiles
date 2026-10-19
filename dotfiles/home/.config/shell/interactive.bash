#                                                         ⡖⠲⠤⠎⠙⣄⡴⢦
#                                                      ⢠⡖⠒⢃⢴⡒⠚⠒⣲⢄⠸⠤⢤
#                                                      ⣀⠽⢰⠃ ⣳⠤⢴⡃ ⢳ ⡞
#                ⣀⡤⣖⡾⢿⠭⠭⠭⠭⠽⣶⡦⣄⡀                        ⠣⡄⢺⠒⠒⣇ ⢀⡗⠒⢺⠂⢉⡆
#             ⢀⣴⣯⢟⣩  ⣞    ⡴⠃⠈⠑⠯⣳⣄                      ⢰⠃⠘⢆⢀⡞⠉⠙⣆⢀⠞⠸⣅
#           ⢀⣴⡿⢋⣼⣋   ⠈    ⠁   ⢀⡬⠿⡷⣄                    ⠈⠉⢹ ⣙⡒⠲⠒⠚⠁⡖⠒⠋
#          ⢀⣞⡞⢠⠏ ⠈            ⠋  ⠘⢞⣆                     ⠈⠛⠁⠱⠤⠋⠙⠒⠃
#          ⣞⡞⢣⣏      ⢀⡤⠔⠒⠒⠦⢄⡀    ⣀⣈⣾⡆
#         ⢸⠙ ⢸      ⢰⠋      ⠙⢆  ⠈⠁ ⢸⢹
#         ⢸  ⢸      ⢸ ⣸⣿⣿⡀   ⠈⡆    ⠈⣿
#         ⢸  ⢸⡀     ⠈⠳⠼⠿⠿     ⡇  ⠒⣲⢤⣿
#         ⠸⡄  ⢳⡀             ⢠⠇  ⢠⢷⣿⣾⣇
#          ⢳⡀  ⠳⣄           ⣠⠏ ⠠⢤⣸⣾⣳⣻⢸
#           ⢳⡀  ⠈⠓⠦⣄⣀   ⢀⣀⠴⠚⠁    ⣻⣷⠧⢽⢸
#            ⠙⢦⡀    ⠈⠉⠉⠉⡁   ⠘⡆  ⣠⢾⢹⣙⣺⡼
#              ⠙⠦⣄⡀    ⢀⡇    ⣳⡤⠞⠁ ⢯⡓⣳⠃
#                 ⠉⠓⠲⠤⠤⠼⠦⠤⠴⠒⠋⠁     ⠉      ⢠⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⢤
#                                         ⡏ ⢰⠒⢲⡖⢲⡖⠒⣶⠒⣶⠒⢲⡖⢲⡖⠒⣶⠒⣶⠒⢲⡖⢲⡖⠚⣇
#                                        ⢸⠁ ⢨⠭⢭⡭⢭⡭⠭⣭⠭⣭⠭⢭⡭⢭⡭⠭⣭⠭⣭⠭⢭⡭⢭⡭⠭⡝⡆
#                                        ⡏  ⢨⠭⢭⡭⢭⡭⠭⣭⠭⣭⠭⢭⡭⢭⡭⠭⣭⠭⣭⠭⢭⡭⢭⡭⠭⡅⢹⡀
#                                       ⢸⠁  ⠘⠒⠚⠓⠚⠓⠒⡿⠶⠿⠶⠾⠷⠾⠷⠶⠿⠶⢿⠒⠚⠓⠚⠓⠒⠃ ⢳
#                                       ⠯⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠭⠇

# Bash-specific interactive setup.
# shellcheck disable=SC2154

# Load shared aliases and functions.

if [[ -r "$HOME/.config/shell/interactive.common.sh" ]]; then
	# shellcheck source=/dev/null
	source "$HOME/.config/shell/interactive.common.sh"
fi

# Add fuzzy paths without discarding native completion functions or options
# Without fzf, leave command-specific and lazy-loaded completions untouched
if declare -F _fzf_setup_completion >/dev/null 2>&1; then
	_fzf_setup_completion path python python3 pip pip3
fi
