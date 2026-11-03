#!/bin/zsh
# .zshenv loads the shared environment so hx uses the normal workstation PATH
set -u

scrollback_file=$1
scrollback_source=$2
scrollback_module=$3
scrollback_session=$REX_SESSION
scrollback_editor=$REX_BLOCK

cleanup() {
  rm -f -- "$scrollback_file"
  rmdir -- "${scrollback_file:h}"
  # Restore only when the editor still has focus and its source still exists
  REX_SESSION= REX_BLOCK= "$REX_BIN_DIR/rex" -S "$REX_SERVER" do \
    "$scrollback_module" restore_focus=true session="$scrollback_session" \
    editor="$scrollback_editor" source="$scrollback_source" >/dev/null
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 143' TERM

hx "$scrollback_file"
