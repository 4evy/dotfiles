#           ⣠⣴⡶
#         ⢀⡞⠅⡞
#         ⡎⡂⠅⡇
#        ⢰⡇⡂⠅⣇
#         ⡇⡂⠅⡚⢦⡀       ⡼
#         ⠘⣆⠅⡂⠅⡛⠶⡤⠤⣤⡄ ⣰⠃
#        ⠠⣄⠈⠳⢦⣅⣂⣅⣢⠵⠋⢀⡴⠃⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀
#         ⠈⠙⠦⢤⣀⣀⣀⣠⠤⠞⠉  ⡇                                    ⢸
#                      ⣇ ⢰⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⡆⢸⡀
#                      ⢸ ⢸ ⢉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⣉⣉⡉⠉⠉⠉⠉⠉⠉⠉⠉ ⡇ ⡇
#                      ⢸ ⢸ ⢸                 ⣰⠋⠁ ⠉⢳⡀       ⡇ ⡇
#                      ⢸ ⢸ ⢸ ⢤⡀             ⢠⠇⢰⡆ ⣶ ⢧       ⡇ ⡇
#                      ⢸⡀⠸⡄⢸  ⠉⣳⠄           ⢸ ⠈⣁ ⣉ ⢸       ⢇ ⣇
#                       ⡇ ⡇⢸ ⠴⠋⠁            ⢸⠔⠳⣬⠟⠳⣀⣸       ⢸ ⢸
#                       ⡇ ⡇⢸                               ⢸ ⢸
#                       ⡇ ⡇⢸ ⠉⠉⠉⠉⠉⠉⠉⠉                      ⢸ ⢸
#                       ⣇ ⡇⠘                               ⢸ ⢸⡀
#                       ⢸ ⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉  ⡇
#                       ⢸⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⡇
#                      ⡴⠋ ⢀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀   ⠹⡄
#                    ⣠⠞   ⢀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀    ⠘⣆
#                  ⢀⡴⠁               ⢀⡴⠋⠉⠉⠉⠉⠉⠉⠳⣄                ⠈⢦
#                  ⠛⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠚⠛⠛⠛⠛⠛⠛⠛⠛⠛⠛⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠚⠃

# A1 / terminal integration
# Detect without writing terminal replies into the shell's input stream
# Remember locally detected values so prompt hooks can refresh them later
if [[ -z "${TERMINAL_THEME:-}" ]] &&
  command -v theme-run >/dev/null 2>&1; then
  if [[ -z "${LC_TERMINAL_THEME:-}${COLOR_SCHEME:-}${THEME:-}${SSH_CONNECTION:-}${SSH_TTY:-}" ]]; then
    typeset -g _terminal_theme_auto=1
  fi
  () {
    local detected_theme
    detected_theme="$(theme-run --print-theme-no-terminal 2>/dev/null)" || detected_theme=
    case "$detected_theme" in
    dark | light) export TERMINAL_THEME="$detected_theme" ;;
    esac
  }
fi

# Keep the exported SSH appearance and Starship profile in sync with the shell
_terminal_theme_apply() {
  case "${TERMINAL_THEME:-}" in
  dark | light)
    export LC_TERMINAL_THEME="$TERMINAL_THEME"
    if [[ "${TERM_PROGRAM:-}" == "Apple_Terminal" ]]; then
      export STARSHIP_CONFIG="$HOME/.config/starship-catppuccin-custom-terminal-${TERMINAL_THEME}.toml"
      if [[ -t 1 ]]; then
        printf '\e]50;SetProfile=Catppuccin Custom %s\a' "${(C)TERMINAL_THEME}"
      fi
    else
      export STARSHIP_CONFIG="$HOME/.config/starship-catppuccin-custom-${TERMINAL_THEME}.toml"
    fi
    ;;
  esac
}
_terminal_theme_apply

if [[ $OSTYPE == darwin* ]]; then
  # Refresh automatic local themes before prompts and commands; ignore our
  # previous exports when detecting, but retain explicit theme overrides
  _terminal_theme_refresh() {
    [[ "${_terminal_theme_auto:-}" == 1 ]] || return 0
    [[ -z "${SSH_CONNECTION:-}${SSH_TTY:-}" ]] || return 0
    local next_theme
    next_theme="$(env -u TERMINAL_THEME -u LC_TERMINAL_THEME \
      theme-run --print-theme-no-terminal 2>/dev/null)" || return 0
    case "$next_theme" in
    dark | light)
      if [[ "$next_theme" != "${TERMINAL_THEME:-}" ]]; then
        export TERMINAL_THEME="$next_theme"
        _terminal_theme_apply
      fi
      ;;
    esac
    return 0
  }
fi
