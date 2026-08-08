import os
import runpy
from collections.abc import Callable
from pathlib import Path
from typing import cast

import pytest


def _merge_filter() -> Callable[[object, str], str]:
    plugin = runpy.run_path(
        os.fspath(Path(__file__).parents[1] / "plugins/filter/dotfiles.py")
    )
    return cast("Callable[[object, str], str]", plugin["merge_gvariant_string_list"])


def _hex_color_filter() -> Callable[[object], str]:
    plugin = runpy.run_path(
        os.fspath(Path(__file__).parents[1] / "plugins/filter/dotfiles.py")
    )
    return cast("Callable[[object], str]", plugin["hex_color_to_rgb_csv"])


def test_hex_color_to_rgb_csv_converts_black_rose_doll_rose() -> None:
    assert _hex_color_filter()("#ce98a5") == "206,152,165"


def test_hex_color_to_rgb_csv_rejects_invalid_colors() -> None:
    with pytest.raises(ValueError, match="six-digit hex color"):
        _hex_color_filter()("rose")


def test_merge_gvariant_string_list_handles_prefix_and_duplicates() -> None:
    merge = _merge_filter()
    path = "/custom/emoji/"
    assert merge("@as ['/custom/other/']", path) == repr([
        "/custom/other/",
        path,
    ])
    assert merge(repr([path]), path) == repr([path])


def test_merge_gvariant_string_list_recovers_from_invalid_value() -> None:
    assert _merge_filter()("not valid", "/custom/emoji/") == repr(["/custom/emoji/"])
