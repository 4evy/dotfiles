import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Protocol, cast

import pytest

REPOSITORY = Path(__file__).parents[2]
HELPER_TEMPLATE = (
    REPOSITORY / "ansible/roles/system/templates/macos/tailscale-ssh-helper.py.in"
)


class TailscaleHelperModule(Protocol):
    ATTEMPTS: int
    subprocess: ModuleType
    time: ModuleType

    def main(self) -> int: ...


@pytest.fixture
def tailscale_helper(tmp_path: Path) -> TailscaleHelperModule:
    rendered = tmp_path / "tailscale-ssh-helper.py"
    source = HELPER_TEMPLATE.read_text(encoding="utf-8").replace(
        "@system_tailscale_bin@",
        "/usr/local/bin/tailscale",
    )
    rendered.write_text(source, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("tailscale_ssh_helper_test", rendered)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return cast("TailscaleHelperModule", module)


def test_tailscale_helper_stops_after_success(
    tailscale_helper: TailscaleHelperModule,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    return_codes = iter((1, 1, 0))
    commands: list[tuple[str, ...]] = []
    sleeps: list[int] = []

    def run(
        argv: tuple[str, ...],
        *,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        assert check is False
        commands.append(argv)
        return subprocess.CompletedProcess(argv, next(return_codes))

    monkeypatch.setattr(tailscale_helper.subprocess, "run", run)
    monkeypatch.setattr(tailscale_helper.time, "sleep", sleeps.append)

    assert tailscale_helper.main() == 0
    assert len(commands) == 3
    assert sleeps == [2, 2]


def test_tailscale_helper_does_not_sleep_after_final_failure(
    tailscale_helper: TailscaleHelperModule,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tailscale_helper.ATTEMPTS = 3
    sleeps: list[int] = []

    def fail(
        argv: tuple[str, ...],
        *,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        assert check is False
        return subprocess.CompletedProcess(argv, 1)

    monkeypatch.setattr(tailscale_helper.subprocess, "run", fail)
    monkeypatch.setattr(tailscale_helper.time, "sleep", sleeps.append)

    assert tailscale_helper.main() == 1
    assert sleeps == [2, 2]
