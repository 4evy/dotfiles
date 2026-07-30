from pathlib import Path
from subprocess import CompletedProcess
from typing import TYPE_CHECKING

from workstation.lib import host
from workstation.lib.host import HostRunner

if TYPE_CHECKING:
    from collections.abc import Sequence

    import pytest


def test_root_runner_disables_privileged_bytecode_writes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    system_runner = tmp_path / "system-runner"
    system_runner.touch(mode=0o755)
    calls: list[tuple[str, ...]] = []

    monkeypatch.setattr(host, "in_container", lambda: False)
    monkeypatch.setattr(host.os, "geteuid", lambda: 1000)
    monkeypatch.setattr(host, "require_commands", lambda *_names: None)
    monkeypatch.setattr(host, "require_executable", Path)

    def record(
        argv: Sequence[str | Path],
        **_kwargs: object,
    ) -> CompletedProcess[str]:
        command = tuple(map(str, argv))
        calls.append(command)
        return CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(host, "run", record)

    HostRunner(system_runner).root(("example", "argument"))

    assert calls == [
        (
            "sudo",
            "-n",
            "/usr/bin/env",
            "PYTHONDONTWRITEBYTECODE=1",
            str(system_runner),
            "--",
            "example",
            "argument",
        )
    ]
