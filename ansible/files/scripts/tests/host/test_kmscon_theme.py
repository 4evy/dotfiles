from __future__ import annotations

import datetime as dt
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Protocol, cast
from zoneinfo import ZoneInfo

import pytest

REPOSITORY = Path(__file__).parents[5]
THEME_SCRIPT = REPOSITORY / "ansible/files/scripts/host/desktop/kmscon-theme-config.py"
REFRESH_SCRIPT = REPOSITORY / "ansible/files/scripts/host/desktop/kmscon-refresh.py"
PALETTE = REPOSITORY / "dotfiles/.chezmoitemplates/catppuccin_palette.json"
UPSTREAM_PALETTE_OPTIONS = {
    "palette-black",
    "palette-red",
    "palette-green",
    "palette-yellow",
    "palette-blue",
    "palette-magenta",
    "palette-cyan",
    "palette-light-grey",
    "palette-dark-grey",
    "palette-light-red",
    "palette-light-green",
    "palette-light-yellow",
    "palette-light-blue",
    "palette-light-magenta",
    "palette-light-cyan",
    "palette-white",
    "palette-foreground",
    "palette-background",
}


class ThemeChoice(Protocol):
    name: str
    source: str


class ThemeModule(Protocol):
    def render_config(
        self,
        palette: dict[str, dict[str, str]],
        now: dt.datetime | None = None,
    ) -> str: ...

    def daylight_theme(self, now: dt.datetime | None = None) -> ThemeChoice: ...


class RefreshModule(Protocol):
    subprocess: ModuleType

    def refresh(self, config: Path, state: Path) -> int: ...

    def session_tty(self, session_id: str) -> str | None: ...


def load_script(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def theme_module() -> ThemeModule:
    return cast("ThemeModule", load_script("kmscon_theme_config_test", THEME_SCRIPT))


@pytest.fixture
def refresh_module() -> RefreshModule:
    return cast("RefreshModule", load_script("kmscon_refresh_test", REFRESH_SCRIPT))


@pytest.fixture
def palette() -> dict[str, dict[str, str]]:
    return json.loads(PALETTE.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    ("theme", "expected"),
    [
        (
            "latte",
            {
                "palette-black=92,95,119",
                "palette-dark-grey=108,111,133",
                "palette-light-grey=172,176,190",
                "palette-white=188,192,204",
                "palette-foreground=76,79,105",
                "palette-background=239,241,245",
            },
        ),
        (
            "frappe",
            {
                "palette-black=81,87,109",
                "palette-dark-grey=98,104,128",
                "palette-light-grey=165,173,206",
                "palette-white=181,191,226",
                "palette-foreground=198,208,245",
                "palette-background=48,52,70",
            },
        ),
    ],
)
def test_rendered_palette_matches_catppuccin_terminal_colors(
    theme_module: ThemeModule,
    palette: dict[str, dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
    theme: str,
    expected: set[str],
) -> None:
    monkeypatch.setenv("DOTFILES_KMSCON_THEME", theme)

    rendered = theme_module.render_config(palette)
    lines = set(rendered.splitlines())

    assert expected <= lines
    assert "palette=custom" in lines
    assert {
        line.partition("=")[0] for line in lines if line.startswith("palette-")
    } == UPSTREAM_PALETTE_OPTIONS


@pytest.mark.parametrize(
    ("hour", "expected"),
    [(0, "frappe"), (12, "latte")],
)
def test_astral_selects_sofia_day_and_night(
    theme_module: ThemeModule,
    monkeypatch: pytest.MonkeyPatch,
    hour: int,
    expected: str,
) -> None:
    monkeypatch.delenv("DOTFILES_KMSCON_THEME", raising=False)
    monkeypatch.delenv("DOTFILES_KMSCON_LATITUDE", raising=False)
    monkeypatch.delenv("DOTFILES_KMSCON_LONGITUDE", raising=False)
    now = dt.datetime(2026, 7, 10, hour, tzinfo=ZoneInfo("Europe/Sofia"))

    choice = theme_module.daylight_theme(now)

    assert choice.name == expected
    assert choice.source.startswith("sun default-sofia")


def test_refresh_tracks_occupied_ttys_until_they_can_restart(
    refresh_module: RefreshModule,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = tmp_path / "kmscon.conf"
    state = tmp_path / "state.json"
    config.write_text("palette=custom\n", encoding="utf-8")
    occupied = {"tty1"}
    calls: list[tuple[str, ...]] = []

    monkeypatch.setattr(refresh_module, "logged_in_ttys", lambda: occupied)

    def record(
        argv: tuple[str, ...], *, check: bool
    ) -> subprocess.CompletedProcess[str]:
        del check
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr(refresh_module.subprocess, "run", record)

    assert refresh_module.refresh(config, state) == 0
    assert [call[-1] for call in calls] == [
        f"kmsconvt@tty{number}.service" for number in range(2, 7)
    ]
    assert json.loads(state.read_text(encoding="utf-8"))["pending_ttys"] == ["tty1"]

    calls.clear()
    assert refresh_module.refresh(config, state) == 0
    assert calls == []

    occupied.clear()
    assert refresh_module.refresh(config, state) == 0
    assert [call[-1] for call in calls] == ["kmsconvt@tty1.service"]
    assert json.loads(state.read_text(encoding="utf-8"))["pending_ttys"] == []

    calls.clear()
    assert refresh_module.refresh(config, state) == 0
    assert calls == []


@pytest.mark.parametrize(
    ("properties", "expected"),
    [
        ("TTY=tty3\nVTNr=3\n", "tty3"),
        ("TTY=pts/4\nVTNr=4\n", "tty4"),
        ("TTY=pts/9\nVTNr=0\n", None),
    ],
)
def test_session_tty_uses_loginctl_properties(
    refresh_module: RefreshModule,
    monkeypatch: pytest.MonkeyPatch,
    properties: str,
    expected: str | None,
) -> None:
    monkeypatch.setattr(refresh_module, "command_output", lambda _argv: properties)

    assert refresh_module.session_tty("session") == expected
