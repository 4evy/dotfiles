import sys
from typing import TYPE_CHECKING

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
