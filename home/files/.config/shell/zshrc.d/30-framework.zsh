#                                                           ⢀⡖⣫⢷⣦⣤⣶⢯⡓⣆
#                                                           ⢸⡀⡇⣾⡟⡛⣟⡆⡇⣸
#                                                            ⢳⡳⣷⣷⣖⣿⡷⣳⠃
#                                                             ⠙⢮⡻⠽⣫⠞⠁
#                       ⢀⣀⣀                            ⡰⠚⠉⠉⠓⣄   ⠙⠚⠁
#                     ⢀⡞⠉⣀⡈⠙⡄                          ⡇⢀⣿⣿ ⢸
#                     ⢸⡀⠸⣿⡿⣄⡸                         ⢀⡳⢎⣀⣀⡤⠋
#                      ⠳⢤⣸⣠⠴⠉⠓⠤⣀                    ⢀⡤⠊
#                        ⢸      ⠉⠒⠤⣀               ⡤⠊
#                        ⢸          ⠉⠲⢤⣀         ⡤⠊
#                        ⢸             ⠈⠙⠲⢤⣰⠚⠉⠉⡷⣎
#                        ⢸                ⠰⡋⠙⠲⣎ ⢸
#                        ⢸                 ⠳⣄⣀⣈⣦⡋
#                        ⢸                      ⠑⣄
#                        ⢸                       ⠈⠳⡀
#                        ⢸                         ⠙⢦⡀
#                        ⢸                           ⠱⣄
#                      ⣠⠖⢺⠒⢦⡀                         ⠈⢣⣠⠤⠤⣄
#                     ⢰⠁ ⠸  ⢳                          ⡎⠙⢄ ⠈⢳
#             ⢀⡠⣴⠂    ⠈⢧⡀  ⣠⠏                          ⣇ ⠈  ⡼
#            ⣠⠏⣺⠁       ⠉⠉⠉⠁                           ⠈⠓⠒⠒⠊⠁
#            ⡇⠅⣺
#            ⡇⠅⡚⣆
#            ⠳⡅⡂⠍⡳⠤⣀⣀⡤
#             ⠙⠢⢥⣂⣥⠦⠛⠁

# B1 / plugins
# Starship owns the prompt; Atuin waits for a real TTY.
export ZSH="$HOME/.oh-my-zsh"
# shellcheck disable=SC2034
ZSH_THEME=""
# Hjem refreshes the external archive; never put update checks on the shell
# startup path. This zstyle is Oh My Zsh's current supported interface.
zstyle ':omz:update' mode disabled
# shellcheck disable=SC2034
DISABLE_UNTRACKED_FILES_DIRTY="true"

# Keep framework and completion state out of $HOME and the managed archive.
ZSH_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/oh-my-zsh"
ZSH_COMPDUMP="${XDG_CACHE_HOME:-$HOME/.cache}/zsh/zcompdump-${ZSH_VERSION}"

# Keep the plugin list explicit
#
# Hjem generates Rustup and GitHub completions during activation. Their Oh
# My Zsh plugins would regenerate them on every shell startup
plugins=(
  git
  nmap
  rsync
  colored-man-pages
  sudo
  extract
  copypath
  copyfile
  fzf-tab
  zsh-autosuggestions
)

# Make cached completions available before compinit.
fpath=("$HOME/.cache/zsh/completions" "${fpath[@]}")

if [[ -r "$ZSH/oh-my-zsh.sh" ]]; then
  # compinit cannot save its dump until the explicit parent directory exists
  [[ -d ${ZSH_COMPDUMP:h} ]] || mkdir -p -- "${ZSH_COMPDUMP:h}"
  # shellcheck source=/dev/null
  source "$ZSH/oh-my-zsh.sh"
fi

# Extend Oh My Zsh's defaults with the upstream history options that remove
# non-adjacent duplicates from searches, memory, and the persisted file.
setopt \
  hist_fcntl_lock \
  hist_find_no_dups \
  hist_ignore_all_dups \
  hist_reduce_blanks \
  hist_save_no_dups \
  no_beep
