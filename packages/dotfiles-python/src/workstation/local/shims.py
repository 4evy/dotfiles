"""Small executable shims installed by the dotfiles package."""

import os
import sys
from pathlib import Path

from workstation.errors import DotfilesError
from workstation.lib.commands import exec_process, which
from workstation.lib.files import is_executable


def _real_codex(home: Path, wrapper: Path) -> Path:
    candidates = (
        os.environ.get("CODEX_REAL_BIN"),
        home / ".bun/bin/codex",
        home / ".cache/.bun/bin/codex",
        home / ".npm/bin/codex",
        home / ".bun/install/global/node_modules/.bin/codex",
        Path("/opt/homebrew/bin/codex"),
        Path("/usr/local/bin/codex"),
        Path("/usr/bin/codex"),
    )
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if path != wrapper and is_executable(path):
            return path
    raise DotfilesError("codex: real Codex binary not found")


def codex_entrypoint() -> None:
    home = Path.home()
    wrapper = Path(sys.argv[0]).resolve()
    real = _real_codex(home, wrapper)
    arguments = list(sys.argv[1:])
    if os.environ.get("TERMINAL_THEME_RUN_ACTIVE"):
        exec_process(real, arguments)
    themed_arguments = arguments.copy()
    if not os.environ.get("TERMINAL_THEME_RUN_CODEX_BIN"):
        themed_arguments = [
            value
            for value in themed_arguments
            if value != "--dangerously-bypass-approvals-and-sandbox"
        ]
    theme_runner = home / ".local/bin/terminal-theme-run"
    if not is_executable(theme_runner):
        theme_runner = which("terminal-theme-run") or theme_runner
    if is_executable(theme_runner):
        environment = dict(os.environ)
        environment["TERMINAL_THEME_RUN_CODEX_BIN"] = os.fspath(real)
        environment["TERMINAL_THEME_RUN_CODEX_WRAPPER"] = os.fspath(wrapper)
        exec_process(theme_runner, ["codex", *themed_arguments], environment)
    exec_process(real, arguments)
