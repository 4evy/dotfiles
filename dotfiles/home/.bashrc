# shellcheck shell=bash
#                                                     ⢀⣀⡀ ⣀⣀
#                    ⢀⣀⡤⢤⣖⣒⣒⣒⣦⠤⣄⣀                    ⢰⢫⢾⣿⣿⢿⢮⢳
#                 ⢀⡴⣺⠽⠒⠉⢩⠇   ⠈⣩⠗⠺⢽⡲⣄                 ⠈⢯⣿⣽⣼⣽⣯⠏
#               ⢀⢞⡽⢻⡵⠚⠁ ⠘⠆   ⠐⠇   ⠈⠻⣽⢆                 ⠙⢿⣻⠟⠁
#              ⡰⣻⠋⡰⠋⠳             ⡴⠋⠉⢻⡳⡀                 ⠁
#             ⡼⣽⡁⡼⠁                   ⠹⡽⡄
#            ⢰⢳⠃⢹⠓      ⢠⠔⠋⠉⠉⠉⠙⠢⣄   ⢀⡤⠤⢷⢳
#            ⡞⠈ ⡞      ⢠⠇ ⣀⣄⡀   ⠈⢧     ⠈⡟⡆
#            ⡇  ⣇      ⠘⡄⢰⣿⣿⣷    ⠈⡇     ⡇⡇
#            ⣇  ⠸⡀      ⠈⠒⠛⠟⠃     ⡇  ⠈⣹⢲⣷⡇
#            ⢸⡀  ⢳⡀              ⣰⠃  ⢠⢧⣻⣽⢹         ⢀⡀ ⢀⡤⣄
#             ⢧   ⠙⢄           ⢀⡴⠃ ⠰⠦⣼⢸⣯⣟⡟⡆        ⡏⠉⠓⠊ ⠘⠦⠚⠙⡆
#             ⠈⢣⡀   ⠙⠢⢄⣀⡀   ⣀⡠⠔⠋     ⣹⣿⠻⠬⡇⡇     ⣞⠉⠚⣡⠶⡏⠉⠉⠉⡷⢦⡘⠦⠤⣄
#               ⠙⣄      ⠉⠉⠉⢉    ⠙⡆  ⢀⣼⣹⣉⣳⢻⠁    ⢀⣨⠆⡼⠁ ⢙⡤⠤⣜⠁ ⠹⡄⢠⠏
#                ⠈⠙⢦⣀      ⢸⠃    ⢧⣠⠞⠉ ⢧⡓⢋⠎     ⢯⡀ ⡧⠤⠤⡏  ⠈⡧⠤⠤⡇⠈⠲⡄
#                   ⠈⠙⠒⠦⠤⣄⣀⣯⣀⡤⠤⠖⠚⠉     ⠉⠉       ⡼ ⢧  ⢙⠦⠤⢞⠁ ⢠⠇⡴⠚⠁
#                                              ⠘⠧⠤⣌⠳⣤⡏  ⠈⣧⡴⢋⡀⢘⡆
#                                                 ⣎⢀⡠⣍⠉⠉⣉⡁ ⡏⠈⠉
#                                                 ⠈⠉ ⠘⠦⠞ ⠉⠛⠁

# Bash startup: environment first, then ordered interactive modules.

# shellcheck source=/dev/null
[[ -r "$HOME/.bashenv" ]] && source "$HOME/.bashenv"

[[ $- == *i* ]] || return 0

_dotfiles_bash_module_dir="$HOME/.config/shell/bashrc.d"
_dotfiles_bash_local_dir="$HOME/.config/shell/bashrc.local.d"

for _dotfiles_bash_module in \
  "$_dotfiles_bash_module_dir"/*.bash \
  "$_dotfiles_bash_local_dir"/*.bash; do
  [[ -r "$_dotfiles_bash_module" ]] || continue
  # shellcheck source=/dev/null
  source "$_dotfiles_bash_module"
done

unset \
  _dotfiles_bash_module \
  _dotfiles_bash_module_dir \
  _dotfiles_bash_local_dir

# Startup-only helpers are intentionally unavailable after initialization.
unset -f _dotfiles_wrap_command _dotfiles_wrap_themed_command _dotfiles_command_path
