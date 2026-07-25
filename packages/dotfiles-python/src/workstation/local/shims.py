"""Small executable shims installed by the dotfiles package."""

import os
import sys
from pathlib import Path

from workstation.errors import DotfilesError
from workstation.lib.commands import exec_process, which


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
        if path != wrapper and path.is_file() and os.access(path, os.X_OK):
            return path
    raise DotfilesError("codex: real Codex binary not found")


def codex_entrypoint() -> None:
    home = Path.home()
    wrapper = Path(sys.argv[0]).resolve()
    real = _real_codex(home, wrapper)
    arguments = list(sys.argv[1:])
    themed_arguments = arguments.copy()
    if not os.environ.get("TERMINAL_THEME_RUN_CODEX_BIN"):
        themed_arguments = [
            value
            for value in themed_arguments
            if value != "--dangerously-bypass-approvals-and-sandbox"
        ]
    theme_runner = home / ".local/bin/terminal-theme-run"
    if not (theme_runner.is_file() and os.access(theme_runner, os.X_OK)):
        theme_runner = which("terminal-theme-run") or theme_runner
    if theme_runner.is_file() and os.access(theme_runner, os.X_OK):
        environment = dict(os.environ)
        environment["TERMINAL_THEME_RUN_CODEX_BIN"] = os.fspath(real)
        environment["TERMINAL_THEME_RUN_CODEX_WRAPPER"] = os.fspath(wrapper)
        exec_process(theme_runner, ["codex", *themed_arguments], environment)
    exec_process(real, arguments)


def _uv_python(executable: str) -> None:
    environment = dict(os.environ)
    environment.setdefault("UV_PYTHON_PREFERENCE", "only-managed")
    exec_process("uv", ["run", executable, *sys.argv[1:]], environment)


def python_entrypoint() -> None:
    _uv_python("python")


def python3_entrypoint() -> None:
    _uv_python("python3")


def vscode_nixd_entrypoint() -> None:
    exec_process(os.environ.get("VSCODE_NIXD_PATH", "nixd"), sys.argv[1:])


def vscode_nixfmt_entrypoint() -> None:
    exec_process(os.environ.get("VSCODE_NIXFMT_PATH", "nixfmt"), sys.argv[1:] or ["-"])
