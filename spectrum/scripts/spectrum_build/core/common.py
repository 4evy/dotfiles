import os
import shlex
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import NoReturn

from workstation.errors import DotfilesError
from workstation.lib.commands import CommandResult, run, which


class BuildError(RuntimeError):
    pass


def fail(message: str) -> NoReturn:
    raise BuildError(message)


class CommandRunner:
    def run(
        self,
        args: Sequence[str | Path],
        *,
        check: bool = True,
        capture: bool = False,
        cwd: str | Path | None = None,
        discard_output: bool = False,
        env: Mapping[str, str] | None = None,
    ) -> CommandResult:
        print(f"+ {shlex.join(map(str, args))}", file=sys.stderr)
        try:
            return run(
                args,
                check=check,
                capture=capture,
                cwd=cwd,
                env=env,
                output_mode="discard" if discard_output else "inherit",
            )
        except DotfilesError as error:
            fail(str(error))

    def output(self, args: Sequence[str | Path]) -> str:
        return self.run(args, capture=True).stdout.strip()

    @staticmethod
    def require(*commands: str) -> None:
        if command := next(
            (command for command in commands if which(command) is None), None
        ):
            fail(f"required command not found: {command}")


def require_readable_file(path: Path) -> None:
    if not path.is_file() or not os.access(path, os.R_OK):
        fail(f"required file is not readable: {path}")
