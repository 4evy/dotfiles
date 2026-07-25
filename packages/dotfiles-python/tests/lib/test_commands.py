import sys
from typing import TYPE_CHECKING

from workstation.lib import commands
from workstation.lib.commands import run

if TYPE_CHECKING:
    import pytest


def test_discard_output_keeps_stderr_diagnostics(
    capfd: pytest.CaptureFixture[str],
) -> None:
    run(
        (
            sys.executable,
            "-c",
            "import sys; print('discarded'); print('diagnostic', file=sys.stderr)",
        ),
        output_mode="discard",
    )

    captured = capfd.readouterr()
    assert "discarded" not in captured.out
    assert "diagnostic" in captured.err


def test_exec_process_preserves_explicit_argv_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, tuple[str, ...], dict[str, str]]] = []
    monkeypatch.setattr(
        commands.os,
        "execvpe",
        lambda executable, arguments, environment: calls.append((
            executable,
            arguments,
            environment,
        )),
    )

    commands.exec_process(
        "/resolved/example",
        ("one", "two"),
        {"EXAMPLE": "value"},
        argument_zero="example",
    )

    assert calls == [
        ("/resolved/example", ("example", "one", "two"), {"EXAMPLE": "value"})
    ]
