import json
import os
from collections.abc import Sequence
from pathlib import Path
from subprocess import CompletedProcess
from typing import TYPE_CHECKING

from workstation.apps import helium

if TYPE_CHECKING:
    import pytest


def test_helium_input_is_prepared_outside_go(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commands: list[tuple[str, ...]] = []

    def fake_run(
        argv: Sequence[str | os.PathLike[str]], **_kwargs: object
    ) -> CompletedProcess[str]:
        command = tuple(map(str, argv))
        commands.append(command)
        return CompletedProcess(command, 0, "caller-supplied-token\n", "")

    monkeypatch.setattr(helium, "run", fake_run)
    monkeypatch.setenv("OP_ACCOUNT", "Private")
    monkeypatch.setenv("DOTFILES_HELIUM_COOKIE_ALLOWLIST", '["[*.]example.com"]')

    apply_input = json.loads(helium._apply_input(helium.HeliumSettings.load()))

    assert apply_input == {
        "cookie_allowlist": ["[*.]example.com"],
        "extension_values": {"refined-github-personal-token": "caller-supplied-token"},
    }
    assert commands == [("op", "read", "op://Private/Refined GitHub/token")]


def test_helium_input_omits_unavailable_private_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OP_ACCOUNT", raising=False)

    assert json.loads(helium._apply_input(helium.HeliumSettings.load())) == {}


def test_profile_avatar_is_downloaded_from_github(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    downloads: list[tuple[str, Path]] = []

    def fake_download(url: str, destination: str | Path) -> Path:
        path = Path(destination)
        downloads.append((url, path))
        return path

    monkeypatch.setattr(helium, "download", fake_download)
    monkeypatch.setenv("XDG_CONFIG_HOME", os.fspath(tmp_path))

    destination = helium._install_profile_avatar("linux")

    assert destination == (
        tmp_path / "net.imput.helium/Default" / helium.CUSTOM_AVATAR_FILENAME
    )
    assert downloads == [(helium.PROFILE_AVATAR_URL, destination)]
