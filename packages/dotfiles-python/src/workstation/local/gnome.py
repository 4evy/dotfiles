"""GNOME desktop commands."""

import subprocess
from typing import Annotated

from cyclopts import App, Group, Parameter, validators
from platformdirs import user_config_path as user_config_home
from pydantic import TypeAdapter

from workstation.lib.commands import output, run, which
from workstation.lib.files import write_if_changed
from workstation.lib.paths import asset_path
from workstation.local.gsettings import available as gsettings_available


def _accent_colors() -> tuple[tuple[str, str], tuple[str, str]]:
    palette = TypeAdapter(dict[str, dict[str, str]]).validate_json(
        asset_path("desktop", "black_rose_doll_palette.json").read_text()
    )
    light = palette["light"]
    dark = palette["dark"]
    return (light["pink"], light["base"]), (dark["pink"], dark["base"])


def _gtk_accent_css(accent: str, accent_fg: str, *, gtk_version: int) -> str:
    source = asset_path("desktop", f"gtk-{gtk_version}-accent.css.in")
    return (
        source
        .read_text(encoding="utf-8")
        .replace("@accent@", accent)
        .replace("@accent_fg@", accent_fg)
    )


def _gnome_accent_apply() -> None:
    light, dark = _accent_colors()
    scheme = (
        output(
            ("gsettings", "get", "org.gnome.desktop.interface", "color-scheme"),
            check=False,
        )
        if gsettings_available()
        else "default"
    )
    accent, accent_fg = dark if "prefer-dark" in scheme else light
    config = user_config_home()
    for version in (3, 4):
        write_if_changed(
            config / f"gtk-{version}.0/black-rose-doll-accent.css",
            _gtk_accent_css(accent, accent_fg, gtk_version=version),
        )
    if not gsettings_available():
        return
    valid = output(
        ("gsettings", "range", "org.gnome.desktop.interface", "accent-color"),
        check=False,
    )
    if "'pink'" in valid:
        run(
            (
                "gsettings",
                "set",
                "org.gnome.desktop.interface",
                "accent-color",
                "pink",
            ),
            check=False,
            capture=True,
        )


_GNOME_ACCENT_MODE = Group("Mode", validator=validators.LimitedChoice(max=1))


def gnome_black_rose_doll_accent(
    *,
    once: Annotated[
        bool,
        Parameter(group=_GNOME_ACCENT_MODE, negative=""),
    ] = False,
    watch: Annotated[
        bool,
        Parameter(group=_GNOME_ACCENT_MODE, negative=""),
    ] = False,
) -> None:
    """Apply the GNOME accent once or watch for color-scheme changes."""
    del once
    _gnome_accent_apply()
    executable = which("gsettings")
    if watch and executable is not None:
        process = subprocess.Popen(
            (
                executable,
                "monitor",
                "org.gnome.desktop.interface",
                "color-scheme",
            ),
            stdout=subprocess.PIPE,
            text=True,
        )
        if process.stdout:
            for _line in process.stdout:
                _gnome_accent_apply()
        raise SystemExit(process.wait())


_gnome_accent_app = App(
    default_command=gnome_black_rose_doll_accent,
    version_flags=[],
    result_action="return_none",
)


def gnome_black_rose_doll_accent_entrypoint() -> None:
    _gnome_accent_app()
