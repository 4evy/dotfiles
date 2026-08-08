import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, NoReturn

import pytest

from workstation.local import shims

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence


class ProcessReplacedError(Exception):
    pass


def test_codex_shim_does_not_rewrap_an_active_themed_invocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real = Path("/real/codex")
    calls: list[tuple[Path, tuple[str, ...], Mapping[str, str] | None]] = []

    def record_exec(
        path: str | os.PathLike[str],
        arguments: Sequence[str],
        environment: Mapping[str, str] | None = None,
        *,
        argument_zero: str | None = None,
    ) -> NoReturn:
        assert argument_zero is None
        calls.append((Path(path), tuple(arguments), environment))
        raise ProcessReplacedError

    monkeypatch.setattr(sys, "argv", ["/wrapper/codex", "resume", "thread-id"])
    monkeypatch.setenv("TERMINAL_THEME_RUN_ACTIVE", "1")
    monkeypatch.setattr(shims, "_real_codex", lambda _home, _wrapper: real)
    monkeypatch.setattr(shims, "exec_process", record_exec)

    with pytest.raises(ProcessReplacedError):
        shims.codex_entrypoint()

    assert calls == [(real, ("resume", "thread-id"), None)]
