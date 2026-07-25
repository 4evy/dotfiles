import json
import os
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING

from workstation.apps import discord
from workstation.lib.commands import CommandResult

if TYPE_CHECKING:
    import pytest


def _discord_app(tmp_path: Path) -> tuple[Path, Path]:
    app = tmp_path / "Discord.app"
    resources = app / "Contents/Resources"
    resources.mkdir(parents=True)
    (resources / "app.asar").write_bytes(b"clean Discord ASAR")
    return app, resources


def test_cli_declares_repair_mode_and_discord_passthrough() -> None:
    command, bound, _ = discord.app.parse_args([
        "--repair-only",
        "--",
        "--start-minimized",
    ])

    assert command is discord.main
    assert bound.arguments == {
        "arguments": ("--start-minimized",),
        "repair_only": True,
    }


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


def test_linux_equilotl_finds_user_install_when_launcher_is_symlinked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    equilotl = home / ".local/bin/EquilotlCli-linux"
    equilotl.parent.mkdir(parents=True)
    equilotl.write_text("#!/bin/sh\n")
    equilotl.chmod(0o755)

    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("DISCORD_EQUICORD_EQUILOTL", raising=False)

    assert discord._linux_equilotl(tmp_path / "uv-tool/bin") == equilotl


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
    ) -> CommandResult:
        command = tuple(map(str, argv))
        commands.append(command)
        if "--repair" in command:
            return CommandResult(1, "", "")
        if "--install" in command:
            (resources / "app.asar").write_bytes(
                b'require("Equicord/equicord.asar")\n{"name": "discord"}'
            )
        return CommandResult(0, "", "")

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
    ) -> CommandResult:
        commands.append(tuple(map(str, argv)))
        return CommandResult(0, "", "")

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
    ) -> CommandResult:
        commands.append(tuple(map(str, argv)))
        return CommandResult(0, "", "")

    monkeypatch.setattr(discord, "user_config_home", lambda: tmp_path / "config")
    monkeypatch.setattr(discord, "run", fake_run)

    discord._patch_location(location, equilotl)

    assert commands == [(str(equilotl), "--repair", "--location", str(location))]
