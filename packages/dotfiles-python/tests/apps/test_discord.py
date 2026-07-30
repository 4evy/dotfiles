import json
import os
from collections.abc import Sequence
from pathlib import Path
from subprocess import CompletedProcess
from typing import TYPE_CHECKING

from workstation.apps import discord

if TYPE_CHECKING:
    import pytest


def _discord_app(tmp_path: Path) -> tuple[Path, Path]:
    app = tmp_path / "Discord.app"
    resources = app / "Contents/Resources"
    resources.mkdir(parents=True)
    (resources / "app.asar").write_bytes(b"clean Discord ASAR")
    return app, resources


def test_gpu_configuration_preserves_unrelated_settings(tmp_path: Path) -> None:
    settings = tmp_path / "settings.json"
    settings.write_text(
        json.dumps({
            "unrelated": "preserved",
            "chromiumSwitches": {"existing_switch": "preserved"},
        })
    )

    discord._configure_gpu(tmp_path)

    configured = json.loads(settings.read_text())
    assert configured["unrelated"] == "preserved"
    assert configured["enableHardwareAcceleration"] is True
    assert configured["chromiumSwitches"] == {
        "existing_switch": "preserved",
        "force_high_performance_gpu": True,
    }


def test_flags_file_uses_shell_quoting_and_comments(tmp_path: Path) -> None:
    path = tmp_path / "discord-flags.conf"
    path.write_text("# comment\n--first\n--label 'two words' # trailing comment\n")

    assert discord._flags_from_file(path) == ["--first", "--label", "two words"]


def test_macos_repair_falls_back_to_install_and_locks_asars(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, resources = _discord_app(tmp_path)
    equilotl = tmp_path / "EquilotlCli-darwin-arm64"
    equilotl.write_text("#!/bin/sh\n")
    equilotl.chmod(0o755)
    commands: list[tuple[str, ...]] = []

    def fake_run(
        argv: Sequence[str | os.PathLike[str]], **_kwargs: object
    ) -> CompletedProcess[str]:
        command = tuple(map(str, argv))
        commands.append(command)
        if "--repair" in command:
            return CompletedProcess(command, 1, "", "")
        if "--install" in command:
            (resources / "app.asar").write_bytes(
                b'require("Equicord/equicord.asar")\n{"name": "discord"}'
            )
        return CompletedProcess(command, 0, "", "")

    monkeypatch.setenv("DISCORD_EQUICORD_APP", str(app))
    monkeypatch.setenv("DISCORD_EQUICORD_EQUILOTL", str(equilotl))
    monkeypatch.setattr(discord, "run", fake_run)

    discord._repair_macos(tmp_path)

    assert [command[1] for command in commands] == [
        "nouchg",
        "--repair",
        "--install",
        "uchg",
    ]


def test_macos_repair_skips_network_when_equicord_is_present(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, resources = _discord_app(tmp_path)
    (resources / "app.asar").write_bytes(
        b'require("Equicord/equicord.asar")\n{"name": "discord"}'
    )
    commands: list[tuple[str, ...]] = []

    def fake_run(
        argv: Sequence[str | os.PathLike[str]], **_kwargs: object
    ) -> CompletedProcess[str]:
        command = tuple(map(str, argv))
        commands.append(command)
        return CompletedProcess(command, 0, "", "")

    monkeypatch.setenv("DISCORD_EQUICORD_APP", str(app))
    monkeypatch.setattr(discord, "run", fake_run)

    discord._repair_macos(tmp_path)

    assert commands == [("chflags", "uchg", str(resources / "app.asar"))]


def test_linux_patch_repairs_loader_from_previous_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    location = tmp_path / "discord/app-1.0.0"
    resources = location / "resources"
    resources.mkdir(parents=True)
    (resources / "app.asar").write_bytes(
        b'require("/var/home/old/.config/Equicord/equicord.asar"){"name": "discord"}'
    )
    (resources / "build_info.json").write_text("{}")
    equilotl = tmp_path / "EquilotlCli-linux"
    equilotl.write_text("#!/bin/sh\n")
    equilotl.chmod(0o755)
    commands: list[tuple[str, ...]] = []

    def fake_run(
        argv: Sequence[str | os.PathLike[str]], **_kwargs: object
    ) -> CompletedProcess[str]:
        command = tuple(map(str, argv))
        commands.append(command)
        return CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(discord, "user_config_home", lambda: tmp_path / "config")
    monkeypatch.setattr(discord, "run", fake_run)

    discord._patch_location(location, equilotl)

    assert commands == [(str(equilotl), "--repair", "--location", str(location))]
