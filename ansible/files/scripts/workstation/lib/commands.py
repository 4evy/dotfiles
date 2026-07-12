import os
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from plumbum import local
from plumbum.commands.processes import (
    CommandNotFound,
    ProcessExecutionError,
    ProcessTimedOut,
)

from workstation.errors import DotfilesError


@dataclass(frozen=True, slots=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


def which(name: str, *, path: str | None = None) -> Path | None:
    if "/" in name:
        candidate = Path(name)
        return (
            candidate if candidate.is_file() and os.access(candidate, os.X_OK) else None
        )
    executable = shutil.which(name, path=path)
    return Path(executable) if executable is not None else None


def require_commands(*names: str) -> None:
    for name in names:
        if which(name) is None:
            raise DotfilesError(f"required command is not available: {name}")


def run(
    argv: Sequence[str | os.PathLike[str]],
    *,
    check: bool = True,
    capture: bool = False,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    input_text: str | None = None,
    timeout: float | None = None,
    output_mode: Literal["inherit", "stderr", "discard"] = "inherit",
) -> CommandResult:
    if not argv:
        raise DotfilesError("run requires a command")
    arguments = [os.fspath(argument) for argument in argv]
    try:
        command = local[arguments[0]][arguments[1:]]
    except CommandNotFound as error:
        raise DotfilesError(f"command is not available: {arguments[0]}") from error

    command_env = dict(local.env)
    if env:
        command_env.update(env)
    kwargs: dict[str, object] = {
        "cwd": os.fspath(cwd) if cwd is not None else None,
        "env": command_env,
        "retcode": 0 if check else None,
        "timeout": timeout,
    }
    if input_text is not None:
        kwargs["stdin"] = input_text
    if output_mode == "discard":
        kwargs["stdout"] = subprocess.DEVNULL
        kwargs["stderr"] = None
    elif not capture:
        kwargs["stdout"] = sys.stderr if output_mode == "stderr" else None
        kwargs["stderr"] = None
    try:
        returncode, stdout, stderr = command.run((), **kwargs)
    except ProcessTimedOut as error:
        raise DotfilesError(
            f"command timed out after {timeout} seconds: {' '.join(arguments)}"
        ) from error
    except ProcessExecutionError as error:
        details = error.stderr.strip() or error.stdout.strip()
        message = f"command failed ({error.retcode}): {' '.join(arguments)}"
        if details:
            message = f"{message}\n{details}"
        raise DotfilesError(message) from error
    return CommandResult(returncode, stdout or "", stderr or "")


def output(
    argv: Sequence[str | os.PathLike[str]],
    *,
    check: bool = True,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> str:
    return run(argv, check=check, capture=True, cwd=cwd, env=env).stdout.rstrip("\n")
