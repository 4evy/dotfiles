#!/usr/bin/env python3.14
"""Shared access to the Catppuccin Custom palette."""

from functools import cache

from pydantic import TypeAdapter

from workstation.lib.paths import asset_path

type Color = tuple[float, float, float]
type Palette = dict[str, str]

_PALETTES = TypeAdapter(dict[str, dict[str, Palette]])


@cache
def palettes() -> dict[str, Palette]:
    """Load and validate the named Catppuccin Custom palette variants once."""
    data = _PALETTES.validate_json(
        asset_path("desktop", "catppuccin_custom_palette.json").read_bytes()
    )
    return data["catppuccin_custom"]


def rgb_components(color: str) -> Color:
    """Convert a six-digit hexadecimal color to normalized RGB components."""
    red, green, blue = bytes.fromhex(color.removeprefix("#"))
    return red / 255, green / 255, blue / 255
