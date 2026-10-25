#              ⢀⡤⣄ ⣰⠛⢲  ⣀⡀
#            ⣀ ⣸ ⠈⢉⣁⣀⣈⠑⠋ ⡟
#           ⠸⡉⠉⢁⡴⠋⣁⡤⡤⣄⡉⠳⣄⠙⠒⠲⡄
#          ⢀⣀⡝⢀⠏ ⣞⢧⣴⣯⣤⢟⡆⠈⢇ ⡞⠁
#          ⢾⣀ ⢸ ⢸⠥⣞⠡⠐⣘⡦⢿ ⢸ ⠙⢲⡄                             ⢀⡴⣒⣲⣤⣴⣒⡲⣄
#           ⢈⡇⠘⡄⠈⣏⡼⢦⡥⠾⣌⡏ ⡜⢀⠖⠚                              ⢸⢸⣁⣿⠟⢿⣇⣹⢸
#           ⢯⣀⣀⠙⢦⡈⠛⠦⠧⠗⠋⣠⠞⠁⠈⢣                               ⠈⢧⡳⣿⣻⣿⡷⣣⠏
#             ⢈⡇ ⣉⠑⠒⠒⠒⠉⠁⢰⠋⠙⠋                                 ⠙⢮⡛⣫⠞⠁
#             ⠈⠓⠊⠁⢹⣀⣰⠋⠙⠦⠞                ⣠⠞⢦⡀                  ⠉⠁
#                  ⠈⠁                    ⠈⢳⠋
#                                         ⢸
#                                         ⢸
#                                  ⢰⠒⠒⠒⠒⠒⠒⠚⠒⠒⠒⠒⠒⠒⢲
#                              ⢀⡤⠤⠤⢼     ⣀⢤⢄⡀    ⢸⠤⠤⠤⣄
#                      ⣀⣀    ⢀⡴⠋   ⢸   ⢰⢻⣈⣼⣂⣩⢳   ⢸   ⠈⠳⣄    ⢀⣀⡀
#                      ⠧⠽⠉⠉⠉⠉⠉ ⢀⣀⣀⣀⣸  ⢀⣏⣡⠛⡉⠍⢣⣩⣇  ⢸⣀⣀⣀⣀ ⠈⠉⠉⠉⠉⠹⠥⠇
#                      ⢀⡀    ⢀⡴⠋   ⢸   ⢧⢊⣧⣐⣈⣎⢢⠇  ⢸   ⠈⠳⣄     ⣀
#                      ⢯⡿⠒⠒⠒⠒⠋     ⢸   ⠘⠮⣂⢹⢐⡨⠞   ⢸     ⠈⠓⠒⠒⠒⠺⣯⠇
#                             ⣠⠞⠉⠉⠉⢹      ⠉⠁     ⢸⠉⠉⠉⠙⢦⡀
#                      ⣏⣻⠒⠒⠒⠒⠚⠁    ⠘⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠚     ⠙⠒⠒⠒⠒⢺⣋⡇

# A2 / startup helpers
# Resolve binaries before generated init scripts replace command names.

_dotfiles_wrap_command() {
  emulate -L zsh
  local -r command_name=$1
  local -r command_path=$2
  eval "$command_name() { command ${(q)command_path} \"\$@\"; }"
}

_dotfiles_wrap_themed_command() {
  emulate -L zsh
  local -r command_name=$1
  eval "$command_name() { command theme-run ${(q)command_name} \"\$@\"; }"
}

# A3 / dotfiles repository
# DOTFILES_REPO takes priority. macOS also checks ~/Developer/dotfiles before
# falling back to ~/dotfiles.

_dotfiles_repo_path="${DOTFILES_REPO:-}"
if [[ -z "$_dotfiles_repo_path" ]]; then
if [[ $OSTYPE == darwin* ]]; then
  _dotfiles_repo_candidates=("$HOME/Developer/dotfiles" "$HOME/dotfiles")
else
  _dotfiles_repo_candidates=("$HOME/dotfiles")
fi
  for _dotfiles_repo_candidate in "${_dotfiles_repo_candidates[@]}"; do
    [[ -f "$_dotfiles_repo_candidate/Justfile" ]] || continue
    [[ -f "$_dotfiles_repo_candidate/flake.nix" ]] || continue
    _dotfiles_repo_path="$_dotfiles_repo_candidate"
    break
  done
fi
if [[ -z "$_dotfiles_repo_path" ]]; then
  _dotfiles_repo_path="$HOME/dotfiles"
fi
if [[ -d "$_dotfiles_repo_path" ]]; then
  # :A resolves the absolute physical path natively, without a subshell.
  _dotfiles_repo_path="${_dotfiles_repo_path:A}"
fi
unset _dotfiles_repo_candidate _dotfiles_repo_candidates

_dotfiles_command_path() {
  emulate -L zsh
  (( $+commands[$1] )) || return 1
  print -r -- "$commands[$1]"
}

