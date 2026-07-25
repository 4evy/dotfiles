import json
import os
from collections.abc import Sequence
from pathlib import Path

import pytest

from workstation.apps import helium
from workstation.errors import DotfilesError
from workstation.lib.commands import CommandResult


def test_helium_profile_avatar_is_installed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source-avatar.png"
    source.write_bytes(b"png avatar")
    config_home = tmp_path / "config"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(config_home))
    monkeypatch.setattr(helium, "asset_path", lambda *_parts: source)

    destination = helium._install_profile_avatar("linux")

    assert destination == (
        config_home / "net.imput.helium" / "Default" / helium.CUSTOM_AVATAR_FILENAME
    )
    assert destination.read_bytes() == b"png avatar"


def test_helium_input_is_prepared_outside_go(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[tuple[str, ...]] = []

    def fake_run(
        argv: Sequence[str | os.PathLike[str]], **_kwargs: object
    ) -> CommandResult:
        command = tuple(map(str, argv))
        commands.append(command)
        return CommandResult(0, "caller-supplied-token\n", "")

    monkeypatch.setattr(helium, "run", fake_run)
    monkeypatch.setattr(helium, "which", lambda _name: tmp_path / "gh")
    monkeypatch.setenv("DOTFILES_HELIUM_COOKIE_ALLOWLIST", '["[*.]example.com"]')

    apply_input = json.loads(helium._apply_input(helium.HeliumSettings.load()))

    assert apply_input == {
        "cookie_allowlist": ["[*.]example.com"],
        "extension_values": {"refined-github-personal-token": "caller-supplied-token"},
    }
    assert commands == [("gh", "auth", "token")]


def test_helium_input_omits_unavailable_private_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        helium,
        "run",
        lambda *_args, **_kwargs: CommandResult(1, "", "unavailable"),
    )
    monkeypatch.setattr(helium, "which", lambda _name: None)

    assert json.loads(helium._apply_input(helium.HeliumSettings.load())) == {}


@pytest.mark.parametrize(
    "value",
    [
        '"not-an-array"',
        '["valid", 1]',
        "not-json",
    ],
)
def test_helium_settings_reject_invalid_cookie_allowlist(
    value: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DOTFILES_HELIUM_COOKIE_ALLOWLIST", value)

    with pytest.raises(DotfilesError, match="invalid Helium installer configuration"):
        helium.HeliumSettings.load()
