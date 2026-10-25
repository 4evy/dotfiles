#!/usr/bin/env bash
set -euo pipefail

tool=$1
shell=$2
case "$tool:$shell" in
	fzf:zsh)
		fzf --zsh | sed \
			-e '/^### completion\.zsh ###$/,$d' \
			-e '/^  eval \$__fzf_key_bindings_options$/i\
  __fzf_key_bindings_options=${__fzf_key_bindings_options/ zle on/}\
  __fzf_key_bindings_options=${__fzf_key_bindings_options/ zle off/}'
		;;
	starship:bash)
		starship init bash --print-full-init | sed "s#$(command -v starship)#starship#g"
		;;
	starship:zsh)
		starship init zsh | sed "s#$(command -v starship)#starship#g"
		;;
	*)
		printf 'Unsupported shell initialization: %s %s\n' "$tool" "$shell" >&2
		exit 2
		;;
esac
