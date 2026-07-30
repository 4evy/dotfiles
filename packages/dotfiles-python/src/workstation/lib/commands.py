import os
import shlex
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import IO, Literal

from workstation.errors import DotfilesError
from workstation.lib.files import is_executable

type ProcessStream = int | IO[str] | None


def _process_streams(
    *,
    capture: bool,
    output_mode: Literal["inherit", "stderr", "discard"],
) -> tuple[ProcessStream, ProcessStream]:
    if capture:
        return subprocess.PIPE, subprocess.PIPE
    if output_mode == "discard":
        return subprocess.DEVNULL, None
    if output_mode == "stderr":
        return sys.stderr, None
    return None, None


def _process_error(
    error: FileNotFoundError
    | subprocess.TimeoutExpired
    | subprocess.CalledProcessError,
    arguments: list[str],
) -> str:
    command = shlex.join(arguments)
    if isinstance(error, FileNotFoundError):
        return f"command is not available: {arguments[0]}"
    if isinstance(error, subprocess.TimeoutExpired):
        return f"command timed out after {error.timeout} seconds: {command}"
    details = (error.stderr or "").strip() or (error.stdout or "").strip()
    message = f"command failed ({error.returncode}): {command}"
    return f"{message}\n{details}" if details else message


def exec_process(
    path: str | os.PathLike[str],
    arguments: Sequence[str],
    environment: Mapping[str, str] | None = None,
    *,
    argument_zero: str | None = None,
) -> None:
    """Replace the current process while preserving an explicit argument vector."""
    executable = os.fspath(path)
    os.execvpe(
        executable,
        (argument_zero or executable, *arguments),
        dict(environment) if environment is not None else os.environ,
    )


def which(name: str, *, path: str | None = None) -> Path | None:
    if "/" in name:
        candidate = Path(name)
        return candidate if is_executable(candidate) else None
    executable = shutil.which(name, path=path)
    return Path(executable) if executable is not None else None


def require_commands(*names: str) -> None:
    if missing := next((name for name in names if which(name) is None), None):
        raise DotfilesError(f"required command is not available: {missing}")


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
) -> subprocess.CompletedProcess[str]:
    if not argv:
        raise DotfilesError("run requires a command")
    arguments = [os.fspath(argument) for argument in argv]
    stdout, stderr = _process_streams(
        capture=capture,
        output_mode=output_mode,
    )
    try:
        result = subprocess.run(
            arguments,
            check=check,
            cwd=cwd,
            env={**os.environ, **env} if env is not None else None,
            input=input_text,
            stdout=stdout,
            stderr=stderr,
            text=True,
            timeout=timeout,
        )
    except (
        FileNotFoundError,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
    ) as error:
        raise DotfilesError(_process_error(error, arguments)) from error
    return result


def output(
    argv: Sequence[str | os.PathLike[str]],
    *,
    check: bool = True,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> str:
    return run(argv, check=check, capture=True, cwd=cwd, env=env).stdout.rstrip("\n")
