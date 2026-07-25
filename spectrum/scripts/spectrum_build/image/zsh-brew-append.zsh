  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv | grep -Ev '\bPATH=')"
  HOMEBREW_PREFIX="${HOMEBREW_PREFIX:-/home/linuxbrew/.linuxbrew}"
  case ":$PATH:" in
    *":${HOMEBREW_PREFIX}/bin:"*) ;;
    *) PATH="${PATH}:${HOMEBREW_PREFIX}/bin" ;;
  esac
  case ":$PATH:" in
    *":${HOMEBREW_PREFIX}/sbin:"*) ;;
    *) PATH="${PATH}:${HOMEBREW_PREFIX}/sbin" ;;
  esac
  export PATH
