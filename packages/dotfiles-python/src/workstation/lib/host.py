import os
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from subprocess import CompletedProcess

from platformdirs import user_bin_path

from workstation.errors import DotfilesError
from workstation.lib.commands import require_commands, run
from workstation.lib.files import require_executable


def in_container() -> bool:
    return Path("/.dockerenv").is_file() or Path("/run/.containerenv").is_file()


def require_root(command: str) -> None:
    """Require the current process to own the host root boundary."""
    if os.geteuid() != 0:
        raise DotfilesError(f"{command}: this command must run as root")


class HostRunner:
    """Run user and privileged host commands without embedding shell programs."""

    def __init__(self, system_runner: Path | None = None) -> None:
        self.system_runner = system_runner or user_bin_path() / "system-runner"

    def user(
        self,
        argv: Sequence[str | os.PathLike[str]],
        *,
        check: bool = True,
        capture: bool = False,
        env: Mapping[str, str] | None = None,
        cwd: str | Path | None = None,
    ) -> CompletedProcess[str]:
        if in_container():
            raise DotfilesError("run_host_user is not supported from containers")
        return run(argv, check=check, capture=capture, env=env, cwd=cwd)

    def root(
        self,
        argv: Sequence[str | os.PathLike[str]],
        *,
        check: bool = True,
        capture: bool = False,
        env: Mapping[str, str] | None = None,
        cwd: str | Path | None = None,
    ) -> CompletedProcess[str]:
        if in_container():
            raise DotfilesError("run_host is not supported from containers")
        if os.geteuid() == 0:
            return run(argv, check=check, capture=capture, env=env, cwd=cwd)
        require_commands("sudo")
        runner = require_executable(self.system_runner)
        command: list[str | os.PathLike[str]] = [
            "sudo",
            "-n",
            "/usr/bin/env",
            "PYTHONDONTWRITEBYTECODE=1",
            runner,
        ]
        for key, value in (env or {}).items():
            command.extend(("--env", f"{key}={value}"))
        command.extend(("--", *argv))
        return run(command, check=check, capture=capture, cwd=cwd)

    def root_output(
        self, argv: Sequence[str | os.PathLike[str]], *, check: bool = True
    ) -> str:
        return self.root(argv, check=check, capture=True).stdout.rstrip("\n")

    def root_python(self, *arguments: str) -> CompletedProcess[str]:
        """Re-enter the installed command package under the host root boundary."""
        return self.root(
            (sys.executable, "-m", "workstation", *arguments),
            check=True,
        )
