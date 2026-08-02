from pathlib import Path
from subprocess import CompletedProcess
from typing import TYPE_CHECKING

from workstation.lib import host
from workstation.lib.host import HostRunner

if TYPE_CHECKING:
    from collections.abc import Sequence

    import pytest


def test_root_runner_uses_sudo_and_disables_privileged_bytecode_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, ...]] = []

    monkeypatch.setattr(host, "in_container", lambda: False)
    monkeypatch.setattr(host.os, "geteuid", lambda: 1000)
    monkeypatch.setattr(host, "require_commands", lambda *_names: None)

    def record(
        argv: Sequence[str | Path],
        **_kwargs: object,
    ) -> CompletedProcess[str]:
        command = tuple(map(str, argv))
        calls.append(command)
        return CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(host, "run", record)

    HostRunner().root(("example", "argument"))

    assert calls == [
        (
            "sudo",
            "/usr/bin/env",
            "PYTHONDONTWRITEBYTECODE=1",
            "--",
            "example",
            "argument",
        )
    ]
