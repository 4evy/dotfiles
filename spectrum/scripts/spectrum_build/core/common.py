from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import NoReturn

from boltons.fileutils import atomic_save


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
        stdout: int | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command = [str(arg) for arg in args]
        print(f"+ {shlex.join(command)}", file=sys.stderr)
        return subprocess.run(command, check=check, stdout=stdout, text=True)

    def output(self, args: Sequence[str | Path]) -> str:
        return self.run(args, stdout=subprocess.PIPE).stdout.strip()

    @staticmethod
    def require(*commands: str) -> None:
        if command := next(
            (command for command in commands if not shutil.which(command)), None
        ):
            fail(f"required command not found: {command}")


def atomic_write(path: Path, data: bytes, mode: int = 0o644) -> None:
    if path.exists() and path.read_bytes() == data:
        path.chmod(mode)
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    with atomic_save(str(path), file_perms=mode, overwrite_part=True) as handle:
        handle.write(data)


def require_readable_file(path: Path) -> None:
    if not path.is_file() or not os.access(path, os.R_OK):
        fail(f"required file is not readable: {path}")
