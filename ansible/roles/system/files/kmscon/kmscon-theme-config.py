#!/usr/bin/env python3.14

import argparse
import datetime as dt
import json
import math
import os
import pathlib
import re
import sys
import tempfile
from contextlib import suppress
from dataclasses import dataclass

ASTRAL_VENDOR_PATH = pathlib.Path("/usr/lib/dotfiles/python")
sys.path.insert(0, str(ASTRAL_VENDOR_PATH))

from astral import Observer  # ruff: ignore[module-import-not-at-top-of-file]
from astral.sun import (  # ruff: ignore[module-import-not-at-top-of-file]
    elevation,
    sunrise,
    sunset,
)

ANSI_ROLE_MAP = {
    "black": "surface1",
    "red": "red",
    "green": "green",
    "yellow": "yellow",
    "blue": "blue",
    "magenta": "pink",
    "cyan": "teal",
    "light-grey": "subtext0",
    "dark-grey": "surface2",
    "light-red": "red",
    "light-green": "green",
    "light-yellow": "yellow",
    "light-blue": "blue",
    "light-magenta": "pink",
    "light-cyan": "teal",
    "white": "subtext1",
    "foreground": "text",
    "background": "base",
}

LIGHT_ROLE_OVERRIDES = {
    "black": "subtext1",
    "white": "surface1",
    "light-grey": "surface2",
    "dark-grey": "subtext0",
}


@dataclass(frozen=True, slots=True)
class ThemeChoice:
    name: str
    source: str


DEFAULT_LATITUDE = 42.6977
DEFAULT_LONGITUDE = 23.3219
HEX_COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}\Z")


def hex_to_rgb_csv(value: str) -> str:
    if HEX_COLOR_RE.fullmatch(value) is None:
        raise ValueError(f"invalid hex color: {value!r}")
    value = value[1:]
    return ",".join(str(int(value[index : index + 2], 16)) for index in (0, 2, 4))


def coordinate_from_env(name: str, minimum: float, maximum: float) -> float | None:
    value = os.environ.get(name)
    if not value:
        return None
    coordinate = float(value)
    if not math.isfinite(coordinate) or coordinate < minimum or coordinate > maximum:
        raise ValueError(
            f"{name} must be between {minimum} and {maximum}: {coordinate}"
        )
    return coordinate


def daylight_theme(now: dt.datetime | None = None) -> ThemeChoice:
    forced = os.environ.get("DOTFILES_KMSCON_THEME")
    if forced:
        if forced not in {"light", "dark"}:
            raise ValueError(f"unsupported DOTFILES_KMSCON_THEME: {forced}")
        return ThemeChoice(forced, "DOTFILES_KMSCON_THEME")
    latitude = coordinate_from_env("DOTFILES_KMSCON_LATITUDE", -90.0, 90.0)
    longitude = coordinate_from_env("DOTFILES_KMSCON_LONGITUDE", -180.0, 180.0)
    if latitude is None and longitude is None:
        latitude = DEFAULT_LATITUDE
        longitude = DEFAULT_LONGITUDE
        location_source = "default-sofia"
    else:
        location_source = "env"
    if latitude is None or longitude is None:
        raise ValueError(
            "set both DOTFILES_KMSCON_LATITUDE and DOTFILES_KMSCON_LONGITUDE for sun-based theme selection"
        )
    now = now or dt.datetime.now().astimezone()
    if now.tzinfo is None:
        raise ValueError("now must include timezone information")
    observer = Observer(latitude=latitude, longitude=longitude)
    try:
        sunrise_at = sunrise(observer, date=now.date(), tzinfo=now.tzinfo)
        sunset_at = sunset(observer, date=now.date(), tzinfo=now.tzinfo)
    except ValueError:
        solar_elevation = elevation(observer, now)
        theme = "light" if solar_elevation >= 0 else "dark"
        return ThemeChoice(
            theme,
            f"sun polar latitude={latitude} longitude={longitude} elevation={solar_elevation:.2f}",
        )
    theme = "light" if sunrise_at <= now < sunset_at else "dark"
    return ThemeChoice(
        theme, f"sun {location_source} latitude={latitude} longitude={longitude}"
    )


def render_config(
    palette: dict[str, dict[str, str]], now: dt.datetime | None = None
) -> str:
    choice = daylight_theme(now)
    colors = palette[choice.name]
    role_map = dict(ANSI_ROLE_MAP)
    if choice.name == "light":
        role_map.update(LIGHT_ROLE_OVERRIDES)
    lines = [
        "# Managed by dotfiles.",
        f"# Theme: black-rose-doll-{choice.name}",
        f"# Theme source: {choice.source}",
        "term=kmscon",
        "font-engine=freetype",
        "font-name=Noto Sans Mono",
        "font-size=18",
        "sb-size=10000",
        "mouse",
        "dpms-timeout=600",
        "palette=custom",
    ]
    for option, role in role_map.items():
        lines.append(f"palette-{option}={hex_to_rgb_csv(colors[role])}")
    return "\n".join(lines) + "\n"


def write_if_changed(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return
    tmp_path: pathlib.Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, delete=False
        ) as handle:
            handle.write(text)
            tmp_path = pathlib.Path(handle.name)
        tmp_path.chmod(0o644)
        tmp_path.replace(path)
    finally:
        if tmp_path is not None:
            with suppress(FileNotFoundError):
                tmp_path.unlink()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("palette_json", type=pathlib.Path)
    parser.add_argument("output_config", type=pathlib.Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    with args.palette_json.open(encoding="utf-8") as handle:
        palette = json.load(handle)
    output_path = args.output_config
    write_if_changed(output_path, render_config(palette))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
