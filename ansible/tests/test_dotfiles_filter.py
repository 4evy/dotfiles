import os
import runpy
from collections.abc import Callable
from pathlib import Path
from typing import cast


def _merge_filter() -> Callable[[object, str], str]:
    plugin = runpy.run_path(
        os.fspath(Path(__file__).parents[1] / "plugins/filter/dotfiles.py")
    )
    return cast("Callable[[object, str], str]", plugin["merge_gvariant_string_list"])


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
