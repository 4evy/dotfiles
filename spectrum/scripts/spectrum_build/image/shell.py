from pathlib import Path

from spectrum_build.core.common import fail

# Spectrum shell policy
#
# This module overrides Bluefin/Homebrew shell defaults because the failure was
# not one command; it was command lookup becoming package-manager-dependent:
#
# - `open .` routed through Bluefin's global `open` alias, then through
#   whichever helper binaries appeared first in PATH. On this host, Homebrew's
#   `gio` was ahead of `/usr/bin/gio`, so desktop-open behavior was no longer
#   anchored to the OS image.
# - Missing zsh commands went through Homebrew's command-not-found hook, which
#   added a slow package-manager lookup to typos and unavailable commands.
# - `brew shellenv` prepends Homebrew bin/sbin. That is useful in an explicit
#   Brew session, but it is the wrong default for an ostree desktop image where
#   host binaries, CA trust, Flatpak helpers, portals, and desktop tools should
#   resolve from the image first.
# - Bluefin's uutils profile can put Brew-provided coreutils/findutils and
#   diffutils ahead of the host. Same class of bug: small command names stop
#   meaning "the OS command".
#
# Policy:
#
# 1. System paths win by default.
# 2. Homebrew stays available as an appended interactive-shell tool path.
# 3. No global alias hides `open`; the image ships a real `/usr/bin/open`
#    wrapper around host `/usr/bin/xdg-open`.
# 4. uutils paths append only; `stty` stays pinned to GNU stty for atuin state
#    restore because uutils stty does not round-trip that state.
# 5. Validation fails loudly if upstream changes these snippets in a way this
#    module does not recognize.
#
# Refs:
#
# - ublue-os/bluefin#687:
#   https://github.com/ublue-os/bluefin/issues/687
#   Core upstream discussion: Homebrew paths before host paths can mask system
#   binaries and break desktop apps.
# - ublue-os/bluefin#4266:
#   https://github.com/ublue-os/bluefin/issues/4266
#   Fish had the same prepend problem after bash was adjusted, confirming this
#   is shell-policy work rather than a one-command workaround.
# - ublue-os/brew#24:
#   https://github.com/ublue-os/brew/issues/24
#   Documents the Fedora `/etc/profile.d`/interactive-shell trap and the TTY
#   login case where Brew PATH can leak into the broader login environment.
# - Homebrew command-not-found docs:
#   https://docs.brew.sh/Command-Not-Found
#   The hook is opt-in shell integration; Spectrum does not enable it by
#   default because typos should not hit Homebrew metadata.
# - Homebrew on Linux docs:
#   https://docs.brew.sh/Homebrew-on-Linux
#   Establishes the Linuxbrew prefix and shellenv model Bluefin integrates.
#
BLUEFIN_OPEN_ALIAS = 'alias open="xdg-open &>/dev/null"'
OPEN_WRAPPER = "/usr/bin/open"

BREW_PROFILE_BAD_PATH_GUARD = '! "$PATH" =~ "/home/linuxbrew.linuxbrew"'
BREW_PROFILE_PATH_GUARD = '! "$PATH" =~ "/home/linuxbrew/.linuxbrew"'
FISH_BREW_APPEND = (
    "fish_add_path --move --append --path (brew --prefix)/bin (brew --prefix)/sbin"
)

UUTILS_PROFILE_PREPEND_LINES = (
    'PATH="/home/linuxbrew/.linuxbrew/opt/uutils-coreutils/libexec/uubin:$PATH"',
    'PATH="/home/linuxbrew/.linuxbrew/opt/uutils-diffutils/libexec/uubin:$PATH"',
    'PATH="/home/linuxbrew/.linuxbrew/opt/uutils-findutils/libexec/uubin:$PATH"',
)
UUTILS_PROFILE_APPEND = """#!/usr/bin/env bash
_ublue_uutils_prefix="${HOMEBREW_PREFIX:-/home/linuxbrew/.linuxbrew}"
if [[ -d "${_ublue_uutils_prefix}/opt/uutils-coreutils/libexec/uubin" && $- == *i* ]] ; then
  for _ublue_uutils_path in \\
    "${_ublue_uutils_prefix}/opt/uutils-coreutils/libexec/uubin" \\
    "${_ublue_uutils_prefix}/opt/uutils-diffutils/libexec/uubin" \\
    "${_ublue_uutils_prefix}/opt/uutils-findutils/libexec/uubin"; do
    case ":$PATH:" in
      *":${_ublue_uutils_path}:"*) ;;
      *) PATH="${PATH}:${_ublue_uutils_path}" ;;
    esac
  done
  unset _ublue_uutils_path
  export PATH
  # Use GNU stty for atuin state restore; uutils stty does not round-trip it.
  alias stty='/usr/bin/stty'
fi
unset _ublue_uutils_prefix"""

ZSH_BREW_SHELLENV = '  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"'
ZSH_BREW_APPEND = """  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv | grep -Ev '\\bPATH=')"
  HOMEBREW_PREFIX="${HOMEBREW_PREFIX:-/home/linuxbrew/.linuxbrew}"
  case ":$PATH:" in
    *":${HOMEBREW_PREFIX}/bin:"*) ;;
    *) PATH="${PATH}:${HOMEBREW_PREFIX}/bin" ;;
  esac
  case ":$PATH:" in
    *":${HOMEBREW_PREFIX}/sbin:"*) ;;
    *) PATH="${PATH}:${HOMEBREW_PREFIX}/sbin" ;;
  esac
  export PATH"""


def _root_path(root: Path, path: str) -> Path:
    return root / path.removeprefix("/")


def remove_bluefin_open_alias(root: Path = Path("/")) -> None:
    for path in (
        _root_path(root, "/usr/etc/profile.d/open.sh"),
        _root_path(root, "/etc/profile.d/open.sh"),
    ):
        if not path.exists():
            continue

        content = path.read_text(encoding="utf-8").strip()
        if content != BLUEFIN_OPEN_ALIAS:
            fail(f"refusing to remove unexpected open alias file: {path}")
        path.unlink()


def patch_brew_profile_guard(root: Path = Path("/")) -> None:
    for path in (
        _root_path(root, "/usr/etc/profile.d/brew.sh"),
        _root_path(root, "/etc/profile.d/brew.sh"),
    ):
        if not path.exists():
            continue

        content = path.read_text(encoding="utf-8")
        if BREW_PROFILE_BAD_PATH_GUARD not in content:
            continue

        path.write_text(
            content.replace(BREW_PROFILE_BAD_PATH_GUARD, BREW_PROFILE_PATH_GUARD),
            encoding="utf-8",
        )


def patch_uutils_profile_path(root: Path = Path("/")) -> None:
    for path in (
        _root_path(root, "/usr/etc/profile.d/uutils.sh"),
        _root_path(root, "/etc/profile.d/uutils.sh"),
    ):
        if not path.exists():
            continue

        content = path.read_text(encoding="utf-8").strip()
        if content == UUTILS_PROFILE_APPEND:
            continue
        if not all(line in content for line in UUTILS_PROFILE_PREPEND_LINES):
            fail(f"unrecognized uutils profile.d script: {path}")

        path.write_text(f"{UUTILS_PROFILE_APPEND}\n", encoding="utf-8")


def patch_bluefin_zsh_brew_path(root: Path = Path("/")) -> None:
    for path in (
        _root_path(root, "/usr/etc/zsh/zshrc"),
        _root_path(root, "/etc/zsh/zshrc"),
    ):
        if not path.exists():
            continue

        content = path.read_text(encoding="utf-8")
        if ZSH_BREW_APPEND in content:
            continue
        if ZSH_BREW_SHELLENV not in content:
            if "/home/linuxbrew/.linuxbrew/bin/brew shellenv" in content:
                fail(f"unrecognized Homebrew shellenv block in {path}")
            continue

        path.write_text(
            content.replace(ZSH_BREW_SHELLENV, ZSH_BREW_APPEND),
            encoding="utf-8",
        )


def align_shell_defaults(root: Path = Path("/")) -> None:
    remove_bluefin_open_alias(root)
    patch_brew_profile_guard(root)
    patch_uutils_profile_path(root)
    patch_bluefin_zsh_brew_path(root)


def validate_shell_defaults(root: Path = Path("/")) -> None:  # noqa: C901
    open_wrapper = _root_path(root, OPEN_WRAPPER)
    if not open_wrapper.is_file():
        fail(f"open command wrapper is missing: {open_wrapper}")
    if not (open_wrapper.stat().st_mode & 0o111):
        fail(f"open command wrapper is not executable: {open_wrapper}")

    for path in (
        _root_path(root, "/usr/etc/profile.d/open.sh"),
        _root_path(root, "/etc/profile.d/open.sh"),
    ):
        if path.exists():
            fail(f"global open alias is still installed: {path}")

    for path in (
        _root_path(root, "/usr/etc/profile.d/brew.sh"),
        _root_path(root, "/etc/profile.d/brew.sh"),
    ):
        if not path.exists():
            continue

        content = path.read_text(encoding="utf-8")
        if BREW_PROFILE_BAD_PATH_GUARD in content:
            fail(f"brew profile.d duplicate-path guard is malformed: {path}")

    for path in (
        _root_path(root, "/usr/etc/profile.d/uutils.sh"),
        _root_path(root, "/etc/profile.d/uutils.sh"),
    ):
        if not path.exists():
            continue

        content = path.read_text(encoding="utf-8").strip()
        if content != UUTILS_PROFILE_APPEND:
            fail(f"uutils profile.d script is not append-only: {path}")

    for path in (
        _root_path(root, "/usr/share/fish/vendor_conf.d/ublue-brew.fish"),
        _root_path(root, "/etc/fish/conf.d/ublue-brew.fish"),
    ):
        if not path.exists():
            continue

        content = path.read_text(encoding="utf-8")
        if "brew shellenv fish | source" in content and FISH_BREW_APPEND not in content:
            fail(f"fish Homebrew setup is not append-only: {path}")

    for path in (
        _root_path(root, "/usr/etc/zsh/zshrc"),
        _root_path(root, "/etc/zsh/zshrc"),
    ):
        if not path.exists():
            continue

        content = path.read_text(encoding="utf-8")
        if ZSH_BREW_SHELLENV in content:
            fail(f"zsh still prepends Homebrew through brew shellenv: {path}")
        if (
            "/home/linuxbrew/.linuxbrew/bin/brew shellenv" in content
            and ZSH_BREW_APPEND not in content
        ):
            fail(f"zsh Homebrew setup is not append-only: {path}")
