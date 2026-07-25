import ast
import os
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

from platformdirs import (
    user_cache_path,
    user_config_path,
    user_data_path,
    user_state_path,
)

from workstation.errors import DotfilesError
from workstation.lib.commands import CommandResult, require_commands, run, which
from workstation.lib.files import require_executable

user_cache_home = user_cache_path
user_config_home = user_config_path
user_data_home = user_data_path
user_state_home = user_state_path


def in_container() -> bool:
    return Path("/.dockerenv").is_file() or Path("/run/.containerenv").is_file()


class HostRunner:
    """Run user and privileged host commands without embedding shell programs."""

    def __init__(self, system_runner: Path | None = None) -> None:
        self.system_runner = system_runner or Path.home() / ".local/bin/system-runner"

    def user(
        self,
        argv: Sequence[str | os.PathLike[str]],
        *,
        check: bool = True,
        capture: bool = False,
        env: Mapping[str, str] | None = None,
        cwd: str | Path | None = None,
    ) -> CommandResult:
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
    ) -> CommandResult:
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

    def root_python(self, *arguments: str) -> CommandResult:
        """Re-enter the installed command package under the host root boundary."""
        return self.root(
            (sys.executable, "-m", "workstation", *arguments),
            check=True,
        )

    @staticmethod
    def has_command(name: str) -> bool:
        return which(name) is not None


def gsettings_available() -> bool:
    return which("gsettings") is not None


def gsettings_writable(schema: str, key: str) -> bool:
    if not gsettings_available():
        return False
    result = run(("gsettings", "writable", schema, key), check=False, capture=True)
    return result.returncode == 0 and result.stdout.strip() == "true"


def enable_gnome_extensions(*uuids: str) -> None:
    if not gsettings_available() or not uuids:
        return
    schema = "org.gnome.shell"
    result = run(
        ("gsettings", "get", schema, "enabled-extensions"),
        check=False,
        capture=True,
    )
    current = result.stdout.strip().removeprefix("@as ").strip()
    try:
        enabled = ast.literal_eval(current)
    except (SyntaxError, ValueError):  # fmt: skip
        return
    if not isinstance(enabled, list):
        return
    values = [value for value in enabled if isinstance(value, str)]
    changed = False
    for uuid in uuids:
        if uuid not in values:
            values.append(uuid)
            changed = True
    if changed:
        run(("gsettings", "set", schema, "enabled-extensions", repr(values)))
